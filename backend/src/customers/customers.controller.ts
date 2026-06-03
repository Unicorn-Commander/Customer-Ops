/**
 * The relationship cockpit REST surface.
 *
 * Mounted under the workspace-scoped path `…/workspaces/:workspaceId/customers`
 * (SUITE-IDENTITY §D4 addressing precedence: path → header → claim). Both the
 * JwtAuthGuard (authn) and the WorkspaceMembershipGuard (authz: membership-gated
 * when tenancy is live; no-op today) apply. The guard resolves + stashes the
 * effective workspace on `req.workspaceId`; the service feeds that into
 * PrismaService.withWorkspace, so every query runs inside the RLS transaction.
 *
 * Tenancy posture (flag-gated, default OFF == today's behavior): with the flag
 * off, the path/claim resolves to the default workspace and nothing 403s; with
 * it on, a non-member is 403'd before any DB read and the RLS GUC is the
 * membership-resolved workspace. The contact details on every read are
 * FEDERATED from Contact-Ops — never copied.
 */

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { CustomersService } from './customers.service';
import {
  AddNoteDto,
  CreateCustomerDto,
  ListCustomersQueryDto,
  MarkLostDto,
  TransitionStageDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@Controller('workspaces/:workspaceId/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'List relationships, filterable by stage/priority/owner.' })
  async list(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListCustomersQueryDto,
  ) {
    return this.customers.listForUser(user, query, workspaceId);
  }

  @Get('pipeline')
  @ApiOperation({ summary: 'Pipeline board: relationships bucketed by funnel stage.' })
  async pipeline(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Query('withContacts') withContacts?: string,
  ) {
    return this.customers.pipelineForUser(user, workspaceId, withContacts !== 'false');
  }

  @Post()
  @ApiOperation({ summary: 'Create a relationship keyed on a federated contactId.' })
  async create(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.createForUser(user, dto, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One relationship + its federated contact summary.' })
  async get(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.getForUser(user, id, workspaceId);
  }

  @Get(':id/360')
  @ApiOperation({
    summary: 'Customer-360: the relationship + timeline + FEDERATED contact, with Phase-3 slots.',
  })
  async customer360(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.customer360ForUser(user, id, workspaceId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Patch relationship fields (priority/owner/value/notes/next-action).' })
  async update(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.updateForUser(user, id, dto, workspaceId);
  }

  @Post(':id/transition')
  @ApiOperation({ summary: 'Move the relationship to a new funnel stage (funnel rules enforced).' })
  async transition(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: TransitionStageDto,
  ) {
    return this.customers.transitionForUser(user, id, dto, workspaceId);
  }

  @Post(':id/lost')
  @ApiOperation({ summary: 'Mark the relationship closed-lost (orthogonal to stage).' })
  async markLost(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: MarkLostDto,
  ) {
    return this.customers.markLostForUser(user, id, dto, workspaceId);
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Re-open a closed-lost relationship.' })
  async reopen(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.reopenForUser(user, id, workspaceId);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Append a freeform note to the relationship timeline.' })
  async addNote(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AddNoteDto,
  ) {
    return this.customers.addNoteForUser(user, id, dto, workspaceId);
  }
}
