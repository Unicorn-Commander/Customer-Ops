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
 *
 * SELECTABLE INFERENCE LANE: each endpoint resolves the inference `tier` per call
 * (request override > the per-agent env default `AGENT_<NAME>_TIER` > 'bundled';
 * see agent-tier.util.ts). The request override may arrive as the POST body `tier`
 * OR the `?tier=` query (the body wins when both are present). This lets an
 * operator A/B Qwen (bundled) vs Claude (metered) — and set the production choice
 * — WITHOUT a redeploy. The resolved tier is a hint only; the entitlement gate
 * still downgrades a metered ask to bundled when the bearer lacks `ai-metered`.
 */

import { Body, Controller, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { LeadTriageAgent } from './lead-triage.agent';
import { FollowUpDrafterAgent } from './follow-up-drafter.agent';
import { CollectionsNudgeAgent } from './collections-nudge.agent';
import { NextBestActionAgent } from './next-best-action.agent';
import { MeetingPrepAgent } from './meeting-prep.agent';
import { AgentTierDto, DraftFollowUpDto } from './dto/agents.dto';
import { resolveTier } from './agent-tier.util';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/** Swagger note shared by the selectable-lane endpoints. */
const TIER_QUERY = {
  name: 'tier',
  required: false,
  enum: ['bundled', 'metered'],
  description:
    'Optional inference-lane override for this call (body `tier` wins over this ' +
    'query, which wins over the AGENT_<NAME>_TIER env, which falls back to ' +
    "'bundled'). A hint only — a metered ask downgrades to bundled without ai-metered.",
} as const;

@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
@Controller('workspaces/:workspaceId/customers/:id/agents')
export class AgentsController {
  constructor(
    private readonly config: ConfigService,
    private readonly leadTriage: LeadTriageAgent,
    private readonly followUp: FollowUpDrafterAgent,
    private readonly collections: CollectionsNudgeAgent,
    private readonly nextBestAction: NextBestActionAgent,
    private readonly meetingPrep: MeetingPrepAgent,
  ) {}

  @Post('triage')
  @ApiOperation({
    summary:
      'Run the lead-triage agent: gather stage + recent engagement + meeting signal, ' +
      'score/prioritize the lead (ranked assessment). Read-only — no side effects.',
  })
  @ApiQuery(TIER_QUERY)
  async triage(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AgentTierDto = {},
    @Query('tier') tierQuery?: string,
  ) {
    const tier = resolveTier(this.config, 'lead-triage', dto.tier ?? tierQuery);
    return this.leadTriage.triage(user, id, workspaceId, tier);
  }

  @Post('follow-up')
  @ApiOperation({
    summary:
      'Run the follow-up drafter: gather contact + relationship + last touch/meeting, ' +
      'draft a follow-up email (draft only). Optionally stage it into the Email-Ops ' +
      'agent inbox (mode=draft) — NEVER auto-sends.',
  })
  @ApiQuery(TIER_QUERY)
  async followUpDraft(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: DraftFollowUpDto,
    @Query('tier') tierQuery?: string,
  ) {
    const tier = resolveTier(this.config, 'follow-up-draft', dto.tier ?? tierQuery);
    return this.followUp.draftFollowUp(
      user,
      id,
      { goal: dto.goal, stageDraft: dto.stageDraft, idempotencyKey: dto.idempotencyKey },
      workspaceId,
      tier,
    );
  }

  @Post('collections-nudge')
  @ApiOperation({
    summary:
      "Run the collections-nudge agent: gather the customer's overdue invoices " +
      '(Accounting-Ops, live status) and draft a polite payment reminder (draft only).',
  })
  @ApiQuery(TIER_QUERY)
  async collectionsNudge(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AgentTierDto = {},
    @Query('tier') tierQuery?: string,
  ) {
    const tier = resolveTier(this.config, 'collections-nudge', dto.tier ?? tierQuery);
    return this.collections.draftNudge(user, id, workspaceId, tier);
  }

  @Post('next-best-action')
  @ApiOperation({
    summary:
      'Run the next-best-action agent: gather relationship + federated meeting / ' +
      'outreach signal and recommend the single best next step (priority + ' +
      'confidence). Read-only — no side effects.',
  })
  @ApiQuery(TIER_QUERY)
  async nextBestActionRecommend(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AgentTierDto = {},
    @Query('tier') tierQuery?: string,
  ) {
    const tier = resolveTier(this.config, 'next-best-action', dto.tier ?? tierQuery);
    return this.nextBestAction.recommend(user, id, workspaceId, tier);
  }

  @Post('meeting-prep')
  @ApiOperation({
    summary:
      'Run the meeting-prep agent: gather meeting history + open action items + ' +
      'invoice/outreach context and produce a prep brief (talking points, open ' +
      'items, suggested agenda, summary). Read-only — no side effects.',
  })
  @ApiQuery(TIER_QUERY)
  async meetingPrepBrief(
    @CurrentUser() user: AuthedUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: AgentTierDto = {},
    @Query('tier') tierQuery?: string,
  ) {
    const tier = resolveTier(this.config, 'meeting-prep', dto.tier ?? tierQuery);
    return this.meetingPrep.prep(user, id, workspaceId, tier);
  }
}
