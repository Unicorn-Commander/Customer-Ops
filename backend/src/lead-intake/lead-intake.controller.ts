/**
 * The lead-ingestion REST surface (Phase 6 — the `ingest_lead` keystone).
 *
 * Mounted under the workspace-scoped path `…/workspaces/:workspaceId/leads`
 * (SUITE-IDENTITY §D4 addressing precedence: path → header → claim), behind the
 * same JwtAuthGuard (authn) + WorkspaceMembershipGuard (authz; no-op until
 * tenancy is live). This is the connector target a leadgen app POSTs a graduated
 * lead to (app-to-app uses a service-account JWT — the suite client-credentials
 * pattern), and the observability surface for the intake buffer.
 *
 *   POST   …/leads/ingest                  land + resolve one lead (idempotent)
 *   GET    …/leads/stats                    status counts (the dashboard headline)
 *   GET    …/leads/intakes                  list intakes (filter by status/source)
 *   GET    …/leads/intakes/:id              one intake
 *   POST   …/leads/resolve-pending          promote PENDING / upgrade provisional
 *   POST   …/leads/intakes/:id/discard      drop an intake (spam/dupe/opt-out)
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { LeadIntakeService } from './lead-intake.service';
import {
  DiscardIntakeDto,
  IngestLeadDto,
  ListIntakesQueryDto,
  ResolvePendingDto,
} from './dto/lead-intake.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@Controller('workspaces/:workspaceId/leads')
export class LeadIntakeController {
  constructor(private readonly leads: LeadIntakeService) {}

  @Post('ingest')
  @ApiOperation({
    summary:
      'Ingest one graduated lead (idempotent on source+sourceDedupKey). Centralizes ' +
      'identity in Contact-Ops, projects a Customer LEAD, and returns the staged ' +
      'intake + resolution outcome. Degrade-clean: stages PENDING when identity ' +
      'cannot be resolved yet.',
  })
  @RequireScopes('write:leads')
  async ingest(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: IngestLeadDto,
  ) {
    return this.leads.ingestForUser(user, dto, workspaceId);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Intake status counts (pending/resolved/failed/discarded).' })
  @RequireScopes('read:leads')
  async stats(@CurrentUser() user: AuthedUser, @Param('workspaceId') workspaceId: string) {
    return this.leads.statsForUser(user, workspaceId);
  }

  @Get('intakes')
  @ApiOperation({ summary: 'List staged intakes, filterable by status/source.' })
  @RequireScopes('read:leads')
  async list(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListIntakesQueryDto,
  ) {
    return this.leads.listForUser(user, query, workspaceId);
  }

  @Get('intakes/:id')
  @ApiOperation({ summary: 'One staged intake by id.' })
  @RequireScopes('read:leads')
  async get(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.leads.getForUser(user, id, workspaceId);
  }

  @Post('resolve-pending')
  @ApiOperation({
    summary:
      'Promote PENDING (and optionally FAILED) intakes, and — once Contact-Ops is ' +
      'reachable — upgrade provisional ids to the canonical person_id. The ' +
      '"wire P-00059 later" reconciler.',
  })
  @RequireScopes('write:leads')
  async resolvePending(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ResolvePendingDto,
  ) {
    return this.leads.resolvePendingForUser(user, dto, workspaceId);
  }

  @Post('intakes/:id/discard')
  @ApiOperation({ summary: 'Discard a staged intake (spam/duplicate/opt-out). Terminal.' })
  @RequireScopes('write:leads')
  async discard(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: DiscardIntakeDto,
  ) {
    return this.leads.discardForUser(user, id, dto, workspaceId);
  }
}
