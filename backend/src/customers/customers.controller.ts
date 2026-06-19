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
  CreateInvoiceDto,
  ListCustomersQueryDto,
  MarkLostDto,
  RecordEngagementDto,
  ScheduleSocialTouchDto,
  SendEmailDto,
  StartCampaignDto,
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
    summary:
      'Customer-360: the relationship + timeline + FEDERATED contact + invoices (Phase 3) + ' +
      'outreach + email panels (Phase 4).',
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

  // ── Phase 3: the Accounting-Ops invoicing surface ──
  // Customer-Ops FEDERATES invoicing to Accounting-Ops (the ledger SoR); these
  // routes never post a journal entry. Degrade-clean when AO is unconfigured;
  // dual-SKU (customer-ops + accounting-ops) gated on create.

  @Get(':id/invoices')
  @ApiOperation({
    summary:
      "This customer's invoices, federated from Accounting-Ops (live status polled). " +
      'Reports connect/entitlement affordances when AO is unconfigured / not entitled.',
  })
  async listInvoices(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.invoicesForUser(user, id, workspaceId);
  }

  @Post(':id/invoices')
  @ApiOperation({
    summary:
      'Assemble a draft from this customer and create the invoice in Accounting-Ops ' +
      '(idempotent on a deterministic external_ref; requires both customer-ops + ' +
      'accounting-ops entitlements).',
  })
  async createInvoice(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.customers.createInvoiceForUser(user, id, dto, workspaceId);
  }

  // ── Phase 4: the Outreach surface (the Outreach app: Listmonk + Postiz) ──
  // Customer-Ops FEDERATES outreach to the Outreach app (the campaign SoR); these
  // routes never send a campaign. Degrade-clean when Outreach is unconfigured;
  // dual-SKU (customer-ops + outreach) gated on the start/schedule actions.

  @Get(':id/outreach')
  @ApiOperation({
    summary:
      "This customer's outreach: live campaigns + touches federated from the Outreach app, " +
      'plus the local enrollment links. Reports connect/entitlement affordances.',
  })
  async listOutreach(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.outreachForUser(user, id, workspaceId);
  }

  @Post(':id/outreach/campaigns')
  @ApiOperation({
    summary:
      "Enroll this customer's contact into an Outreach campaign/sequence (idempotent; " +
      'requires customer-ops + outreach entitlements). Federates to the Outreach app.',
  })
  async startCampaign(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: StartCampaignDto,
  ) {
    return this.customers.startCampaignForUser(user, id, dto, workspaceId);
  }

  @Post(':id/outreach/social')
  @ApiOperation({
    summary:
      "Schedule a Postiz social touch for this customer's contact (idempotent; requires " +
      'customer-ops + outreach). Federates to the Outreach app.',
  })
  async scheduleSocialTouch(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: ScheduleSocialTouchDto,
  ) {
    return this.customers.scheduleSocialTouchForUser(user, id, dto, workspaceId);
  }

  // ── Phase 4: the Email surface (the Email-Ops app: Stalwart) ──
  // Customer-Ops FEDERATES mailboxes to the Email-Ops app (the mailbox SoR);
  // these routes never store a message body. Degrade-clean when Email-Ops is
  // unconfigured; dual-SKU (customer-ops + email-ops) gated on send/draft.

  @Get(':id/email')
  @ApiOperation({
    summary:
      "This customer's email: live mailbox threads with the contact federated from the " +
      'Email-Ops app, plus the local outbound links. Reports connect/entitlement affordances.',
  })
  async listEmail(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.emailForUser(user, id, workspaceId);
  }

  @Post(':id/email')
  @ApiOperation({
    summary:
      "Send or draft an outbound email to this customer's contact via the Email-Ops app " +
      '(idempotent; requires customer-ops + email-ops). mode=send delivers now; mode=draft ' +
      'stages the agent-inbox approval surface.',
  })
  async sendEmail(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: SendEmailDto,
  ) {
    return this.customers.sendEmailForUser(user, id, dto, workspaceId);
  }

  // ── Phase 5: the Meeting-Ops signal surface (conversation intelligence) ──
  // Customer-Ops FEDERATES meetings/summaries/action-items from Meeting-Ops at
  // read time (never copied; no local table). Degrade-clean when Meeting-Ops is
  // unconfigured. Reads are viewer-level (no dual-SKU).

  @Get(':id/meetings')
  @ApiOperation({
    summary:
      "This customer's meetings + summaries + action items, federated from Meeting-Ops " +
      '(the conversation-intelligence app). Read-only; reports connect affordance when ' +
      'Meeting-Ops is unconfigured.',
  })
  async listMeetings(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.meetingsForUser(user, id, workspaceId);
  }

  // Customer-Ops FEDERATES projects/delivery status from Project-Ops at read time
  // (never copied; no local table). Degrade-clean when Project-Ops is unconfigured.
  // Reads are viewer-level.

  @Get(':id/projects')
  @ApiOperation({
    summary:
      "The projects Project-Ops is delivering for this customer's account, matched on the " +
      'federated org/contact name. Read-only; reports a connect affordance when Project-Ops ' +
      'is unconfigured.',
  })
  async listProjects(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.customers.projectsForUser(user, id, workspaceId);
  }

  // ── Phase 4: the engagement → funnel-stage hook ──
  // An inbound engagement signal (reply/click from Outreach/Email-Ops; a bounce)
  // advances the customer's funnel stage when positive, with activity logging.
  // This is the endpoint the Outreach/Email-Ops webhooks (or an agent) call.

  @Post(':id/engagement')
  @ApiOperation({
    summary:
      'Record an inbound engagement (reply/click/open/bounce) and advance the funnel stage ' +
      'when the signal warrants it (one step, never skipping qualification). Logs the stage ' +
      'change + the engagement provenance in one transaction.',
  })
  async recordEngagement(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: RecordEngagementDto,
  ) {
    return this.customers.recordEngagementForUser(user, id, dto, workspaceId);
  }
}
