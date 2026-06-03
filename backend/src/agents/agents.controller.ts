/**
 * The relationship AGENT cockpit actions (Phase 5).
 *
 * Mounted under the same workspace-scoped path as the customers cockpit
 * (`…/workspaces/:workspaceId/customers/:id/agents/*`). Both the JwtAuthGuard
 * (authn) and the WorkspaceMembershipGuard (authz: membership-gated when tenancy
 * is live) apply — so the agents respect RBAC exactly like every other cockpit
 * route, and run inside the RLS transaction. The 4-lane inference is
 * entitlement/metering-gated inside each agent (AgentInferencePort).
 *
 * Every action is DRAFT-ONLY + human-in-the-loop: it returns the agent's
 * structured output (an assessment or a draft) for a human to review/approve. No
 * action auto-sends mail, posts an invoice, or moves a stage. The follow-up
 * drafter can OPTIONALLY stage its draft into the Email-Ops agent inbox
 * (mode='draft'), which is still NOT a send.
 */

import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { LeadTriageAgent } from './lead-triage.agent';
import { FollowUpDrafterAgent } from './follow-up-drafter.agent';
import { CollectionsNudgeAgent } from './collections-nudge.agent';
import { DraftFollowUpDto } from './dto/agents.dto';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@Controller('workspaces/:workspaceId/customers/:id/agents')
export class AgentsController {
  constructor(
    private readonly leadTriage: LeadTriageAgent,
    private readonly followUp: FollowUpDrafterAgent,
    private readonly collections: CollectionsNudgeAgent,
  ) {}

  @Post('triage')
  @ApiOperation({
    summary:
      'Run the lead-triage agent: gather stage + recent engagement + meeting signal, ' +
      'score/prioritize the lead (ranked assessment). Read-only — no side effects.',
  })
  async triage(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.leadTriage.triage(user, id, workspaceId);
  }

  @Post('follow-up')
  @ApiOperation({
    summary:
      'Run the follow-up drafter: gather contact + relationship + last touch/meeting, ' +
      'draft a follow-up email (draft only). Optionally stage it into the Email-Ops ' +
      'agent inbox (mode=draft) — NEVER auto-sends.',
  })
  async followUpDraft(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: DraftFollowUpDto,
  ) {
    return this.followUp.draftFollowUp(
      user,
      id,
      { goal: dto.goal, stageDraft: dto.stageDraft, idempotencyKey: dto.idempotencyKey },
      workspaceId,
    );
  }

  @Post('collections-nudge')
  @ApiOperation({
    summary:
      "Run the collections-nudge agent: gather the customer's overdue invoices " +
      '(Accounting-Ops, live status) and draft a polite payment reminder (draft only).',
  })
  async collectionsNudge(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    return this.collections.draftNudge(user, id, workspaceId);
  }
}
