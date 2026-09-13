import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../auth/decorators/require-workspace-role.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { QuotesLifecycleService } from './quotes-lifecycle.service';

@Controller('workspaces/:workspaceId/letterhead')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
export class QuotesLetterheadController {
  constructor(private readonly lifecycle: QuotesLifecycleService) {}
  @Get('resolved')
  @RequireScopes('read:quotes')
  read(@Req() req: any, @Param('workspaceId') workspace: string) {
    return this.lifecycle.letterheadSettings(req.user, workspace);
  }
  @Put()
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.ADMIN)
  update(@Req() req: any, @Param('workspaceId') workspace: string, @Body() body: unknown) {
    return this.lifecycle.letterheadSettings(req.user, workspace, body);
  }
}
