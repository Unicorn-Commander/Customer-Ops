/**
 * The command-center OVERVIEW REST surface.
 *
 * Mounted under the workspace-scoped path `…/workspaces/:workspaceId/overview`
 * (SUITE-IDENTITY §D4 addressing precedence: path → header → claim), with the
 * SAME guards as the customers cockpit — the JwtAuthGuard (authn) + the
 * WorkspaceMembershipGuard (authz: membership-gated when tenancy is live; no-op
 * today). The guard resolves + stashes the effective workspace on
 * `req.workspaceId`; the service feeds that into PrismaService.withWorkspace, so
 * every aggregate read runs inside the RLS transaction.
 *
 * These endpoints roll up Customer-Ops's LOCAL link tables across the whole
 * workspace (fast, no live federation fan-out, degrade-clean), to power the
 * top-level "see everything at a glance" pages. The only thing federated is the
 * contact LABEL on each row (resolved once per request, batched); each row
 * deep-links to that customer's 360 for the live detail.
 */

import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { OverviewService } from './overview.service';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('overview')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@Controller('workspaces/:workspaceId/overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('invoices')
  @ApiOperation({
    summary:
      'Command-center invoices overview: every local invoice link in the workspace ' +
      '(newest first, federated contact label) + a summary (count, per-status counts, ' +
      'total outstanding, currency). Each row deep-links to the customer-360 for live status.',
  })
  async invoices(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    return this.overview.invoicesForUser(user, workspaceId);
  }

  @Get('outreach')
  @ApiOperation({
    summary:
      'Command-center outreach overview: every local outreach link in the workspace ' +
      '(newest first, federated contact label) + a summary (count, per-status counts). ' +
      'Each row deep-links to the customer-360 for the live campaign/touch history.',
  })
  async outreach(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    return this.overview.outreachForUser(user, workspaceId);
  }

  @Get('email')
  @ApiOperation({
    summary:
      'Command-center email overview: every local outbound-email link in the workspace ' +
      '(newest first, federated contact label) + a summary (count, send/draft split). ' +
      'Each row deep-links to the customer-360 for the live thread.',
  })
  async email(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    return this.overview.emailForUser(user, workspaceId);
  }
}
