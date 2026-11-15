import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtOnly } from '../auth/decorators/jwt-only.decorator';
import { RequireWorkspaceRole } from '../auth/decorators/require-workspace-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/**
 * Pause and resume a member (owner only), the app's half of the suite's
 * removal rule: access stops at the next request when membership is enforced,
 * credentials are kept, a sign-in cannot undo a pause, the last owner cannot be
 * paused. Registered only when PROVISIONING_ENABLED is on (ProvisioningModule),
 * so with the flag off both paths answer the framework's own 404.
 */
@ApiTags('workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
@Controller('workspaces/:workspaceId/members/:userKey')
export class MemberPauseController {
  constructor(
    private readonly membership: MembershipService,
    private readonly audit: AuditService,
  ) {}

  @Post('pause')
  @JwtOnly()
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause a member (owner only; credentials kept; last owner refused).' })
  pause(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('userKey') userKey: string,
  ) {
    return this.setPaused(user, workspaceId, userKey, true);
  }

  @Post('resume')
  @JwtOnly()
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused member (owner only).' })
  resume(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('userKey') userKey: string,
  ) {
    return this.setPaused(user, workspaceId, userKey, false);
  }

  private async setPaused(user: AuthedUser, workspaceId: string, userKey: string, paused: boolean) {
    await this.membership.assertOwner(user, workspaceId);
    const updated = paused
      ? await this.membership.pauseMember(workspaceId, userKey)
      : await this.membership.resumeMember(workspaceId, userKey);
    await this.audit.log({
      workspaceId,
      userId: ucUidOf(user),
      action: AuditAction.UPDATE,
      resource: 'membership',
      resourceId: userKey,
      details: { paused },
    });
    return {
      user_key: updated.userKey,
      role: String(updated.role).toLowerCase(),
      status: String(updated.status).toLowerCase(),
    };
  }
}
