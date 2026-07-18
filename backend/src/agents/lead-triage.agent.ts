/**
 * LeadTriageAgent (Phase 5) — score/prioritize a lead from federated signal.
 *
 * The agent COMPOSES (it does not own any data):
 *   - the LOCAL relationship + recent timeline (RLS tx; Customer-Ops owns these),
 *   - the FEDERATED Contact-Ops contact summary (communication strength, last
 *     interaction),
 *   - the FEDERATED Meeting-Ops signal (meeting count, last meeting, open action
 *     items, freshest summary headline) — the Phase-5 conversation signal,
 *   - the FEDERATED Outreach touch history (last engagement) — read viewer-level,
 * then hands a prompt to the 4-lane inference seam (AgentInferencePort) and parses
 * a STRUCTURED assessment (score 0-100 + recommended priority + rationale + next
 * action). It logs ONE CustomerActivity(AGENT_RUN) and returns the assessment.
 *
 * NO SIDE EFFECTS (binding): triage only READS + SCORES. It NEVER moves the stage,
 * sets the priority, sends mail, or posts anything. The score/priority are a
 * RECOMMENDATION for a human; the cockpit decides whether to act. `draftOnly:true`
 * is asserted on the result.
 *
 * DEGRADE-CLEAN: when the inference gateway is not configured (or the caller is
 * not entitled), the agent still assembles + returns the federated signal snapshot
 * (so the cockpit shows the context) with a null score + an explanatory note — it
 * never throws and never blocks. Federation reads are individually best-effort.
 *
 * ENTITLEMENT: gated through AgentInferencePort.checkEntitlement (the 4-lane
 * model — `customer-ops` for the bundled lane). The inference lane is SELECTABLE
 * (caller `tier` override > AGENT_LEAD_TRIAGE_TIER env > 'bundled'; see
 * agent-tier.util.ts); it defaults to the BUNDLED tier (a relationship agent in
 * the seat price, lanes 1-2; SUITE-ARCHITECTURE-MAP §8), so it does not require
 * `ai-metered` unless 'metered' is selected (which the gate then gates on it).
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { OutreachTouch } from '../outreach-ops/outreach-ops.types';
import { AgentInferencePort, InferenceContext } from './inference/agent-inference.port';
import { AgentInferenceEcho, LeadTriageResult, LeadTriageSignals } from './agents.types';
import { AgentInferenceResult, InferenceTier } from './inference/agent-inference.types';
import { safeJsonObject, strOrNull } from './agent-parse.util';

@Injectable()
export class LeadTriageAgent {
  private readonly logger = new Logger(LeadTriageAgent.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly meetingOps: MeetingOpsPort,
    private readonly outreach: OutreachPort,
    private readonly inference: AgentInferencePort,
  ) {}

  /**
   * Triage one customer-relationship: gather stage + recent engagement + meeting
   * signal, score/prioritize the lead, log AGENT_RUN, return the assessment. No
   * side effects.
   */
  async triage(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
    tier: InferenceTier = 'bundled',
  ): Promise<LeadTriageResult> {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    // Runtime, workspace-scoped kill switch: halt the agent run at dispatch when
    // this workspace is paused (re-read every call — a flip takes effect now).
    await this.workspaces.assertAgentsNotPaused(workspaceId);
    // Bind the entitlement claim to the acting workspace once (intersect with its
    // server-side entitlements); every gate below consumes this bound set.
    const entitlements = await this.workspaces.effectiveEntitlements(user, workspaceId);

    // 1) LOCAL relationship (RLS tx; 404 if absent in the workspace).
    const rel = await this.workspaces.runForUser(
      user,
      (tx) => this.loadRelationship(tx, customerId),
      requestedWorkspaceId,
    );

    // 2) FEDERATE the signal (best-effort; degrade-clean). Outside the DB tx.
    const fedCtx = { workspaceId, ucUid: ucUid || null };
    const [contact, meetingSignal, touches] = await Promise.all([
      this.contactOps.getContact(fedCtx, rel.contactId).catch(() => null),
      this.meetingOps.getMeetingSignal(fedCtx, rel.contactId).catch(() => null),
      this.outreach.isConfigured()
        ? this.outreach
            .listTouchesForContact(
              { workspaceId, ucUid: ucUid || null, entitlements },
              rel.contactId,
            )
            .catch((): OutreachTouch[] => [])
        : Promise.resolve<OutreachTouch[]>([]),
    ]);

    // The most-recent outreach engagement, if any.
    let lastEngagementKind: string | null = null;
    let lastEngagementAt = 0;
    for (const t of touches) {
      if (t.lastEngagementKind && t.lastEngagementAt) {
        const at = Date.parse(t.lastEngagementAt);
        if (at >= lastEngagementAt) {
          lastEngagementAt = at;
          lastEngagementKind = t.lastEngagementKind;
        }
      }
    }

    const daysSince = rel.lastStageChangeAt
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(rel.lastStageChangeAt).getTime()) / 86_400_000),
        )
      : null;

    const signals: LeadTriageSignals = {
      stage: rel.stage,
      priority: rel.priority,
      isLost: !!rel.isLost,
      daysSinceLastStageChange: daysSince,
      expectedValue: rel.expectedValue != null ? rel.expectedValue.toString() : null,
      contactDisplayName: contact?.displayName ?? null,
      communicationStrength: contact?.communicationStrength ?? null,
      lastInteractionAt: contact?.lastInteractionAt ?? null,
      meetingCount: meetingSignal?.meetingCount ?? 0,
      lastMeetingAt: meetingSignal?.lastMeetingAt ?? null,
      openActionItemCount: meetingSignal?.openActionItemCount ?? 0,
      latestSummaryHeadline: meetingSignal?.latestSummaryHeadline ?? null,
      lastEngagementKind,
      outreachTouchCount: touches.length,
    };

    // 3) ENTITLEMENT + INFERENCE (the SELECTABLE tier — defaults to 'bundled', a
    //    relationship agent in the seat price; a caller may select 'metered' for
    //    the frontier lane, which the gate then requires `ai-metered` for).
    const infCtx: InferenceContext = {
      workspaceId,
      ucUid: ucUid || null,
      entitlements,
    };
    const gate = this.inference.checkEntitlement(infCtx, tier);
    const configured = this.inference.isConfigured();

    let assessment: ParsedTriage | null = null;
    let inferenceEcho: AgentInferenceEcho | null = null;
    let note: string;

    if (!configured) {
      note =
        'Inference not configured — returning the federated signal snapshot only (connect inference to score).';
    } else if (!gate.allowed) {
      note = `Not entitled to run the triage agent: ${gate.reason}`;
    } else {
      const result = await this.inference.complete(infCtx, {
        task: 'lead-triage',
        tier,
        responseFormat: 'json',
        temperature: 0.2,
        maxOutputTokens: 700,
        messages: this.buildPrompt(signals),
      });
      if (!result) {
        note = 'Inference gateway did not return a result — returning the signal snapshot only.';
      } else {
        inferenceEcho = this.echo(result);
        assessment = this.parse(result.text);
        note = assessment
          ? `Scored ${assessment.score ?? '?'}/100 (recommend ${assessment.recommendedPriority ?? 'n/a'} priority).`
          : 'Inference returned an unparseable assessment — returning the signal snapshot only.';
      }
    }

    // 4) LOG the agent run (RLS tx) — the audit trail that triage ran. No PII.
    await this.logRun(user, customerId, requestedWorkspaceId, note, inferenceEcho);

    return {
      customerId,
      contactId: rel.contactId,
      agent: 'lead-triage',
      inferenceConfigured: configured,
      entitled: gate.allowed,
      tierUsed: inferenceEcho ? (inferenceEcho.metered ? 'metered' : 'bundled') : null,
      inference: inferenceEcho,
      draftOnly: true,
      note,
      score: assessment?.score ?? null,
      recommendedPriority: assessment?.recommendedPriority ?? null,
      rationale: assessment?.rationale ?? null,
      suggestedNextAction: assessment?.suggestedNextAction ?? null,
      signals,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async loadRelationship(tx: WorkspaceTxClient, customerId: string) {
    const row = await tx.customer.findUnique({ where: { id: customerId } });
    if (!row) throw new NotFoundException(`Customer ${customerId} not found`);
    return row;
  }

  private buildPrompt(signals: LeadTriageSignals) {
    const system =
      'You are a B2B sales lead-triage assistant inside a relationship cockpit. ' +
      'Given a snapshot of a customer relationship and its federated engagement / ' +
      'meeting signal, score how hot the lead is and recommend a priority. You do ' +
      'NOT take any action — you only assess. Respond with STRICT JSON only, no ' +
      'prose outside the JSON, matching exactly: ' +
      '{"score": <integer 0-100>, "recommendedPriority": "low"|"medium"|"high", ' +
      '"rationale": "<2-3 sentences>", "suggestedNextAction": "<one concrete next step>"}. ' +
      'Weight recent two-way engagement (replies, meetings, open action items) and ' +
      'communication strength highly; weight staleness (many days since the stage ' +
      'changed with no engagement) negatively.';
    const user =
      'Relationship signal:\n' + JSON.stringify(signals, null, 2) + '\nReturn the JSON assessment.';
    return [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
  }

  private parse(text: string): ParsedTriage | null {
    const obj = safeJsonObject(text);
    if (!obj) return null;
    const scoreRaw = obj['score'];
    const score =
      typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)
        ? Math.max(0, Math.min(100, Math.round(scoreRaw)))
        : null;
    const prRaw = String(obj['recommendedPriority'] ?? '').toLowerCase();
    const recommendedPriority =
      prRaw === 'low' || prRaw === 'medium' || prRaw === 'high'
        ? (prRaw as 'low' | 'medium' | 'high')
        : null;
    const rationale = strOrNull(obj['rationale']);
    const suggestedNextAction = strOrNull(obj['suggestedNextAction']);
    return { score, recommendedPriority, rationale, suggestedNextAction };
  }

  private echo(r: AgentInferenceResult): AgentInferenceEcho {
    return {
      lane: r.lane,
      model: r.model,
      metered: r.metered,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    };
  }

  private async logRun(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId: string | null | undefined,
    note: string,
    echo: AgentInferenceEcho | null,
  ) {
    const lane = echo?.lane != null ? ` · lane ${echo.lane}` : '';
    await this.workspaces.runForUser(
      user,
      async (tx) => {
        const wsRows = await tx.$queryRaw<
          Array<{ ws: string | null }>
        >`SELECT current_workspace_id() AS ws`;
        const workspaceId = wsRows?.[0]?.ws;
        if (!workspaceId) return;
        await tx.customerActivity.create({
          data: {
            workspaceId,
            customerId,
            kind: CustomerActivityKind.AGENT_RUN,
            body: `lead-triage agent ran — ${note}${lane}`,
            actorUcUid: ucUidOf(user) || null,
          },
        });
      },
      requestedWorkspaceId,
    );
  }
}

interface ParsedTriage {
  score: number | null;
  recommendedPriority: 'low' | 'medium' | 'high' | null;
  rationale: string | null;
  suggestedNextAction: string | null;
}
