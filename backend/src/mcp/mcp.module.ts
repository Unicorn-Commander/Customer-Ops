import { QuotesModule } from '../quotes/quotes.module';
import { Module, DynamicModule } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { CustomersModule } from '../customers/customers.module';
import { AgentsModule } from '../agents/agents.module';
import { LeadIntakeModule } from '../lead-intake/lead-intake.module';
import { AuditModule } from '../audit/audit.module';

@Module({})
export class McpModule {
  static register(quotes: boolean): DynamicModule {
    return {
      module: McpModule,
      // CustomersModule exports CustomersService so the cockpit MCP tools run the
      // SAME relationship logic as the REST surface; AgentsModule exports the three
      // Phase-5 relationship agents so the agent MCP tools (triage_customer /
      // draft_followup / draft_collections_nudge) run the SAME agent logic as the
      // REST cockpit actions (one implementation, two surfaces). LeadIntakeModule
      // exports LeadIntakeService so the Phase-6 ingest tools (ingest_lead /
      // list_lead_intakes / resolve_pending_leads) hit the same pipeline.
      imports: [
        QuotesModule.register(quotes),
        AuthModule,
        WorkspaceModule,
        CustomersModule,
        AgentsModule,
        LeadIntakeModule,
        AuditModule,
      ],
      controllers: [McpController],
      providers: [McpService],
    };
  }
}
