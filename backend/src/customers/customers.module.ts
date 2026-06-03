import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

/**
 * The relationship cockpit module (Phase 2).
 *
 * Wires the CustomersService (relationship logic + funnel + customer-360) and
 * its REST surface. Depends on:
 *   - WorkspaceModule — the GUC chokepoint + membership guard (RLS tenancy).
 *   - AuthModule — the JwtAuthGuard for the workspace-scoped routes.
 *   - ContactOpsModule — the federation port (contacts resolved, never copied).
 *
 * The service is exported so the MCP cockpit tools (mcp.tools) reuse the exact
 * same relationship logic an HTTP caller hits — one implementation, two
 * surfaces.
 */
@Module({
  imports: [WorkspaceModule, AuthModule, ContactOpsModule],
  providers: [CustomersService],
  controllers: [CustomersController],
  exports: [CustomersService],
})
export class CustomersModule {}
