import { Body, Controller, Get, Headers, Param, Post, Req, Query, UseGuards } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { RequireWorkspaceRole } from '../auth/decorators/require-workspace-role.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { QuoteDocumentService } from './quote-document.service';
import { QuotesLifecycleService } from './quotes-lifecycle.service';

@Controller('quotes')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard, WorkspaceRoleGuard)
export class QuotesLifecycleController {
  constructor(
    private readonly lifecycle: QuotesLifecycleService,
    private readonly documents: QuoteDocumentService,
  ) {}
  @Get(':id/render')
  @RequireScopes('read:quotes')
  render(@Req() req: any, @Param('id') id: string, @Query('format') format: string) {
    return this.documents.render(req.user, req.workspaceId, id, format === 'pdf' ? 'pdf' : 'html');
  }
  @Post(':id/send')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  send(@Req() req: any, @Param('id') id: string, @Headers('idempotency-key') key: string) {
    return this.lifecycle.send(req.user, req.workspaceId, id, key);
  }
  @Post(':id/supersede')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  supersede(@Req() req: any, @Param('id') id: string) {
    return this.lifecycle.supersede(req.user, req.workspaceId, id);
  }
  @Post(':id/tokens/:tokenId/revoke')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.MEMBER)
  revoke(@Req() req: any, @Param('id') id: string, @Param('tokenId') tokenId: string) {
    return this.lifecycle.revoke(req.user, req.workspaceId, id, tokenId);
  }
  @Post(':id/record-acceptance')
  @RequireScopes('write:quotes')
  @RequireWorkspaceRole(WorkspaceRole.OWNER)
  record(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.lifecycle.recordAcceptance(req.user, req.workspaceId, id, body, key);
  }
  @Get(':id/versions')
  @RequireScopes('read:quotes')
  versions(@Req() req: any, @Param('id') id: string) {
    return this.lifecycle.history(req.user, req.workspaceId, id, 'versions');
  }
  @Get(':id/events')
  @RequireScopes('read:quotes')
  events(@Req() req: any, @Param('id') id: string) {
    return this.lifecycle.history(req.user, req.workspaceId, id, 'events');
  }
}
