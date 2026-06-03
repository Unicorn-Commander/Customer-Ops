import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { CustomersModule } from '../customers/customers.module';

@Module({
  // CustomersModule exports CustomersService so the Phase-2 cockpit MCP tools
  // run the SAME relationship logic as the REST surface (one implementation).
  imports: [AuthModule, WorkspaceModule, CustomersModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
