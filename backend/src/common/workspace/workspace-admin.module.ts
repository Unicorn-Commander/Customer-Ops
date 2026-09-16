import {
  WorkspaceOnboardingController,
  OnboardingSessionGuard,
} from './workspace-onboarding.controller';
import { Module } from '@nestjs/common';
import { WorkspaceModule } from './workspace.module';
import { AuditModule } from '../../audit/audit.module';
import { WorkspaceController } from './workspace.controller';

/**
 * The workspace settings REST surface (identity + member roster + owner-gated
 * member management). Kept in its own module — separate from the shared
 * WorkspaceModule (the tenancy seam imported everywhere) — so it can pull in
 * AuditModule for the membership-mutation audit trail without WorkspaceModule
 * gaining an AuditModule dependency (which would be circular: AuditService
 * depends on WorkspaceContextService).
 */
@Module({
  imports: [WorkspaceModule, AuditModule],
  controllers: [WorkspaceController, WorkspaceOnboardingController],
  providers: [OnboardingSessionGuard],
})
export class WorkspaceAdminModule {}
