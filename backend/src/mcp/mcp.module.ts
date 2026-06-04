import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { CustomersModule } from '../customers/customers.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  // CustomersModule exports CustomersService so the cockpit MCP tools run the
  // SAME relationship logic as the REST surface; AgentsModule exports the three
  // Phase-5 relationship agents so the agent MCP tools (triage_customer /
  // draft_followup / draft_collections_nudge) run the SAME agent logic as the
  // REST cockpit actions (one implementation, two surfaces).
  imports: [AuthModule, WorkspaceModule, CustomersModule, AgentsModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
