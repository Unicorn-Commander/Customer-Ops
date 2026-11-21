import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { HomeSummaryController } from './home-summary.controller';
import { ServiceCallerGuard } from './home-summary.caller';
import { HomeSummaryService } from './home-summary.service';

/**
 * The read-only HOME-SUMMARY surface (HOME-SUMMARY CONTRACT v1) the Ops-Center
 * Home calls for a named person. Depends on:
 *   - WorkspaceModule — the membership lookup (person -> role in workspace).
 *   - ContactOpsModule — federated contact display names for follow-up items.
 * The caller guard (ServiceCallerGuard) verifies the service token against the
 * app's EXISTING realm JWKS + realm issuer directly; this module does NOT import
 * AuthModule and the route is NOT behind JwtAuthGuard (no User resolution, no
 * provisioning for a service token). The only side effect is one INFO log line;
 * there is no AuditService (DB) write.
 * PrismaService is global (PrismaModule).
 */
@Module({
  imports: [WorkspaceModule, ContactOpsModule],
  controllers: [HomeSummaryController],
  providers: [HomeSummaryService, ServiceCallerGuard],
  exports: [HomeSummaryService],
})
export class HomeSummaryModule {}
