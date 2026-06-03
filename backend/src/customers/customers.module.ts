import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { AccountingOpsModule } from '../accounting-ops/accounting-ops.module';
import { OutreachOpsModule } from '../outreach-ops/outreach-ops.module';
import { EmailOpsModule } from '../email-ops/email-ops.module';
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
 *
 * The service is exported so the MCP cockpit tools (mcp.tools) reuse the exact
 * same relationship logic an HTTP caller hits — one implementation, two
 * surfaces.
 */
@Module({
  imports: [
    WorkspaceModule,
    AuthModule,
    ContactOpsModule,
    AccountingOpsModule,
    OutreachOpsModule,
    EmailOpsModule,
  ],
  providers: [CustomersService],
  controllers: [CustomersController],
  exports: [CustomersService],
})
export class CustomersModule {}
