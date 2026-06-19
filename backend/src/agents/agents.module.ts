import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { AuthModule } from '../auth/auth.module';
import { ContactOpsModule } from '../contact-ops/contact-ops.module';
import { MeetingOpsModule } from '../meeting-ops/meeting-ops.module';
import { OutreachOpsModule } from '../outreach-ops/outreach-ops.module';
import { CustomersModule } from '../customers/customers.module';
import { AgentInferenceModule } from './inference/agent-inference.module';
import { LeadTriageAgent } from './lead-triage.agent';
import { FollowUpDrafterAgent } from './follow-up-drafter.agent';
import { CollectionsNudgeAgent } from './collections-nudge.agent';
import { NextBestActionAgent } from './next-best-action.agent';
import { MeetingPrepAgent } from './meeting-prep.agent';
import { AgentsController } from './agents.controller';

/**
 * The relationship AGENTS module (Phase 5).
 *
 * Wires the five DRAFT-ONLY relationship agents (lead-triage, follow-up drafter,
 * collections nudge, next-best-action, meeting-prep) + their cockpit-action REST
 * surface. Each agent COMPOSES the existing federation ports + the local
 * relationship and calls the 4-lane inference seam (on a SELECTABLE tier — request
 * override > AGENT_<NAME>_TIER env > 'bundled'; see agent-tier.util.ts). Depends on:
 *   - WorkspaceModule — the GUC chokepoint + membership guard (RLS tenancy + RBAC).
 *   - AuthModule — the JwtAuthGuard for the workspace-scoped routes.
 *   - ContactOpsModule — the contact federation port (read-time contact resolve).
 *   - MeetingOpsModule — the Phase-5 Meeting-Ops federation port (conversation
 *     signal: meetings/summaries/action-items, never copied).
 *   - OutreachOpsModule — the Outreach port (touch history; viewer-level reads).
 *   - AgentInferenceModule — the 4-lane inference port (entitlement/metering-gated;
 *     mockable; degrade-clean when unconfigured).
 *   - CustomersModule — reused for the Phase-3 invoice panel (collections) + the
 *     Phase-4 mode='draft' Email-Ops staging path (follow-up), so the agents hit
 *     the exact same idempotent, dual-SKU-gated logic a human does. Never used to
 *     SEND.
 *
 * The agents are exported so the MCP agent tools (triage_customer / draft_followup
 * / draft_collections_nudge / next_best_action / meeting_prep) run the SAME agent
 * logic the REST cockpit hits — one implementation, two surfaces.
 */
@Module({
  imports: [
    WorkspaceModule,
    AuthModule,
    ContactOpsModule,
    MeetingOpsModule,
    OutreachOpsModule,
    AgentInferenceModule,
    CustomersModule,
  ],
  providers: [
    LeadTriageAgent,
    FollowUpDrafterAgent,
    CollectionsNudgeAgent,
    NextBestActionAgent,
    MeetingPrepAgent,
  ],
  controllers: [AgentsController],
  exports: [
    LeadTriageAgent,
    FollowUpDrafterAgent,
    CollectionsNudgeAgent,
    NextBestActionAgent,
    MeetingPrepAgent,
  ],
})
export class AgentsModule {}
