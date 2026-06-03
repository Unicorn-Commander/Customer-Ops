import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';

@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
