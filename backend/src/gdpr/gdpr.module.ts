import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuditModule } from '../audit/audit.module';
import { GraphModule } from '../graph/graph.module';
import { GdprService } from './gdpr.service';
import { RetentionSweepService } from './retention-sweep.service';
import { GdprController } from './gdpr.controller';

/**
 * The GDPR data-lifecycle module — right-to-erasure, right-to-portability
 * (export), workspace offboarding, and the flag-gated DORMANT-record retention
 * sweep.
 *
 * Reuses the existing seams (no fork):
 *   - WorkspaceModule — the RLS GUC chokepoint (WorkspaceContextService) + the
 *     membership gate (MembershipService.assertOwner) + the route authz guard.
 *   - AuthModule      — the JwtAuthGuard for the workspace-scoped routes.
 *   - AuditModule     — the append-only trail: every erasure logs DELETE, every
 *     export logs EXPORT.
 *   - GraphModule     — GraphIngestService for the FalkorDB subgraph/graph
 *     cleanup (degrade-clean; the erasure completes on Postgres even when the
 *     graph is dormant, so the dependency is soft — GdprService injects it
 *     @Optional).
 *
 * PrismaService is @Global (PrismaModule), so it injects without an import here.
 */
@Module({
  imports: [ConfigModule, AuthModule, WorkspaceModule, AuditModule, GraphModule],
  providers: [GdprService, RetentionSweepService],
  controllers: [GdprController],
  exports: [GdprService, RetentionSweepService],
})
export class GdprModule {}
