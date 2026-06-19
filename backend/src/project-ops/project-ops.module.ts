import { Module } from '@nestjs/common';
import { ProjectOpsPort } from './project-ops.port';
import { ProjectOpsClient } from './project-ops.client';

/**
 * The Project-Ops federation seam — the delivery/projects surface on the
 * customer-360.
 *
 * Binds the abstract `ProjectOpsPort` (what the relationship layer depends on) to
 * the concrete `ProjectOpsClient` (JSON-RPC MCP to Project-Ops' native
 * search_projects). Consumers inject `ProjectOpsPort`; tests override that
 * provider with a fake — Project-Ops is never required to be running.
 *
 * This is the ONLY place a real Project-Ops transport is constructed. Project-Ops
 * remains the system-of-record for projects and tasks; this seam is read-only and
 * never creates a project or task — exactly like the Meeting-Ops seam.
 */
@Module({
  providers: [{ provide: ProjectOpsPort, useClass: ProjectOpsClient }],
  exports: [ProjectOpsPort],
})
export class ProjectOpsModule {}
