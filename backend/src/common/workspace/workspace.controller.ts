/**
 * The workspace settings surface (SUITE-IDENTITY §D4): identity + the member
 * roster + owner-gated member management. Mounted at the bare workspace path
 * `…/workspaces/:workspaceId` (more specific paths — /customers, /audit, … —
 * are owned by their own controllers).
 *
 * Guards: JwtAuthGuard (authn) + WorkspaceMembershipGuard (authz — a non-member
 * is 403'd before any read when tenancy is live). Reads are PAT-accessible with
 * `read:overview`; member MUTATIONS are `@JwtOnly()` (session-only — a leaked
 * PAT must not be able to change roles or remove members) AND owner-gated in the
 * service. memberships is a control-plane table, so RBAC + the last-owner
 * lockout rail are enforced in code, and every mutation is audited.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtOnly } from '../../auth/decorators/jwt-only.decorator';
import { RequireScopes } from '../../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../../auth/decorators/require-workspace-role.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AuditService } from '../../audit/audit.service';
import { MembershipService } from './membership.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { ucUidOf, WithWorkspaceClaim } from './workspace.util';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
@Controller('workspaces/:workspaceId')
export class WorkspaceController {
  constructor(
    private readonly membership: MembershipService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireScopes('read:overview')
  @ApiOperation({ summary: 'Workspace identity + your role + member count.' })
  async detail(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    const ws = await this.membership.getWorkspaceOrThrow(workspaceId);
    const [yourRole, members] = await Promise.all([
      this.membership.roleInWorkspace(user, workspaceId),
      this.membership.listWorkspaceMembers(workspaceId, user),
    ]);
    return {
      workspace_id: ws.id,
      slug: ws.slug,
      display_name: ws.displayName,
      status: ws.status,
      isolation_mode: ws.isolationMode,
      isolation_tier: ws.isolationTier,
      hipaa_mode: ws.hipaaMode,
      gdpr_mode: ws.gdprMode,
      data_residency: ws.dataResidency,
      created_at: ws.createdAt,
      your_role: yourRole ? String(yourRole).toLowerCase() : null,
      member_count: members.filter((m) => m.status === 'active').length,
    };
  }

  @Get('members')
  @RequireScopes('read:overview')
  @ApiOperation({ summary: 'The workspace member roster (role, status, last sign-in).' })
  async members(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    const [members, yourRole] = await Promise.all([
      this.membership.listWorkspaceMembers(workspaceId, user),
      this.membership.roleInWorkspace(user, workspaceId),
    ]);
    // `canManage` lets the UI show/hide the owner-only controls without guessing.
    return { members, your_role: yourRole ? String(yourRole).toLowerCase() : null, can_manage: yourRole === 'OWNER' };
  }

  @Patch('members/:userKey')
  @JwtOnly()
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  @ApiOperation({ summary: 'Change a member’s role (owner only; cannot demote the last owner).' })
  async setRole(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('userKey') userKey: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    await this.membership.assertOwner(user, workspaceId);
    const updated = await this.membership.setMemberRole(workspaceId, userKey, dto.role);
    await this.audit.log({
      workspaceId,
      userId: ucUidOf(user),
      action: AuditAction.UPDATE,
      resource: 'membership',
      resourceId: userKey,
      details: { role: dto.role },
    });
    return { user_key: updated.userKey, role: String(updated.role).toLowerCase(), status: String(updated.status).toLowerCase() };
  }

  @Delete('members/:userKey')
  @JwtOnly()
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member (owner only; cannot remove the last owner).' })
  async revoke(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('userKey') userKey: string,
  ) {
    await this.membership.assertOwner(user, workspaceId);
    await this.membership.revokeMember(workspaceId, userKey);
    await this.audit.log({
      workspaceId,
      userId: ucUidOf(user),
      action: AuditAction.DELETE,
      resource: 'membership',
      resourceId: userKey,
      details: { revoked: true },
    });
  }
}
