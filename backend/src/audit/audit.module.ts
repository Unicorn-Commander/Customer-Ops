import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * The audit module — the system audit trail (append-only `audit_logs`).
 *
 * Reuses the existing tenancy seams (no fork):
 *   - WorkspaceModule — the GUC chokepoint + membership guard (RLS tenancy +
 *     RBAC); every write/read runs inside the workspace-bound transaction.
 *   - AuthModule      — the JwtAuthGuard for the workspace-scoped read routes.
 *
 * AuditService is exported so the relationship layer (CustomersService) and any
 * future writer can record events through the one append-only seam.
 */
@Module({
  imports: [WorkspaceModule, AuthModule],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
