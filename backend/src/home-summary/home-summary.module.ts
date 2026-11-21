import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { AuditModule } from '../audit/audit.module';
import { HomeSummaryController } from './home-summary.controller';
import { HomeSummaryService } from './home-summary.service';

/**
 * The read-only HOME-SUMMARY surface (HOME-SUMMARY CONTRACT v1) the Ops-Center
 * Home calls for a named person. Depends on:
 *   - WorkspaceModule — the membership lookup (person -> role in workspace).
 *   - AuthModule      — JwtAuthGuard (the app's existing trusted JWKS verifies
 *                       the caller token; no new trust root here).
 *   - ContactOpsModule — federated contact display names for follow-up items.
 *   - AuditModule     — the one allowed side effect (a READ audit line).
 * PrismaService is global (PrismaModule).
 */
@Module({
  imports: [WorkspaceModule, AuthModule, ContactOpsModule, AuditModule],
  controllers: [HomeSummaryController],
  providers: [HomeSummaryService],
  exports: [HomeSummaryService],
})
export class HomeSummaryModule {}
