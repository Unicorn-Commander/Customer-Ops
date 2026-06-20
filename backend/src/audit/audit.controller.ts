import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { AuditService } from './audit.service';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/**
 * The system audit-trail READ surface.
 *
 * Mounted under the workspace-scoped path `…/workspaces/:workspaceId/audit`
 * (SUITE-IDENTITY §D4) with the SAME guards as the cockpit — JwtAuthGuard
 * (authn) + WorkspaceMembershipGuard (authz: membership-gated, now live). The
 * service runs every read inside the workspace RLS transaction, so a caller only
 * ever sees their own workspace's trail. Writes happen server-side
 * (AuditService.log from the relationship write paths), never via HTTP.
 */
@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@Controller('workspaces/:workspaceId/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary:
      'Paginated audit trail for the workspace (newest first). Optional filters: ' +
      'action (CREATE/UPDATE/…), resource (e.g. customer). Append-only; read-only here.',
  })
  async list(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('action') action?: string,
    @Query('resource') resource?: string,
  ) {
    return this.audit.findForUser(user, workspaceId, {
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
      action: action ? (action as AuditAction) : undefined,
      resource: resource || undefined,
    });
  }

  @Get('resource/:resource/:resourceId')
  @ApiOperation({
    summary: 'Audit history for one target entity (e.g. a customer), newest first.',
  })
  async byResource(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('resource') resource: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.audit.findByResource(user, resource, resourceId, workspaceId);
  }
}
