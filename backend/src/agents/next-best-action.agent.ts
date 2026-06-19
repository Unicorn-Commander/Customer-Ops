/**
 * NextBestActionAgent (Phase 5+) — recommend the single best next step on a
 * relationship from federated signal.
 *
 * The agent COMPOSES (it does not own any data):
 *   - the LOCAL relationship + pipeline state (RLS tx; stage, priority, expected
 *     value, staleness, the cockpit's nextActionAt) — Customer-Ops owns these,
 *   - the FEDERATED Contact-Ops contact summary (communication strength, last
 *     interaction),
 *   - the FEDERATED Meeting-Ops signal (meeting count, last meeting, open action
 *     items, freshest summary headline) — the conversation signal,
 *   - the FEDERATED Outreach touch history (last engagement) — viewer-level reads,
 * then hands a prompt to the 4-lane inference seam (AgentInferencePort) and parses
 * a STRUCTURED recommendation (one next action + rationale + priority + confidence).
 * It logs ONE CustomerActivity(AGENT_RUN) and returns the recommendation.
 *
 * NO SIDE EFFECTS (binding): this agent only READS + RECOMMENDS. It NEVER moves the
 * stage, sets the priority, schedules the action, sends mail, or posts anything.
 * The recommendation is for a human; the cockpit decides whether to act.
 * `draftOnly:true` is asserted on the result.
 *
 * DEGRADE-CLEAN: when the inference gateway is not configured (or the caller is not
 * entitled), the agent still assembles + returns the federated signal snapshot
 * (context for the cockpit) with a null action + an explanatory note — it never
 * throws and never blocks. Federation reads are individually best-effort.
 *
 * ENTITLEMENT: gated through AgentInferencePort.checkEntitlement (the 4-lane
 * model — `customer-ops` for the bundled lane). The inference lane is SELECTABLE
 * (caller `tier` override > AGENT_NEXT_BEST_ACTION_TIER env > 'bundled'; see
 * agent-tier.util.ts); it defaults to BUNDLED (a relationship agent in the seat
 * price, lanes 1-2), so it does not require `ai-metered` unless 'metered' is
 * selected (which the gate then gates on it).
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, entitlementsOf, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { OutreachTouch } from '../outreach-ops/outreach-ops.types';
import { AgentInferencePort, InferenceContext } from './inference/agent-inference.port';
import { AgentInferenceEcho, NextBestActionResult, NextBestActionSignals } from './agents.types';
import { AgentInferenceResult, InferenceTier } from './inference/agent-inference.types';
import { safeJsonObject, strOrNull } from './agent-parse.util';

@Injectable()
export class NextBestActionAgent {
  private readonly logger = new Logger(NextBestActionAgent.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly meetingOps: MeetingOpsPort,
    private readonly outreach: OutreachPort,
    private readonly inference: AgentInferencePort,
  ) {}

  /**
   * Recommend the single best next action on one customer-relationship: gather the
   * pipeline state + federated engagement/meeting signal, ask for one concrete next
   * step, log AGENT_RUN, return the recommendation. No side effects.
   */
  async recommend(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
    tier: InferenceTier = 'bundled',
  ): Promise<NextBestActionResult> {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);

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
              { workspaceId, ucUid: ucUid || null, entitlements: entitlementsOf(user) },
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

    const signals: NextBestActionSignals = {
      stage: rel.stage,
      priority: rel.priority,
      isLost: !!rel.isLost,
      daysSinceLastStageChange: daysSince,
      expectedValue: rel.expectedValue != null ? rel.expectedValue.toString() : null,
      nextActionAt: rel.nextActionAt ? new Date(rel.nextActionAt).toISOString() : null,
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

    // 3) ENTITLEMENT + INFERENCE (the SELECTABLE tier — defaults to 'bundled').
    const infCtx: InferenceContext = {
      workspaceId,
      ucUid: ucUid || null,
      entitlements: entitlementsOf(user),
    };
    const gate = this.inference.checkEntitlement(infCtx, tier);
    const configured = this.inference.isConfigured();

    let parsed: ParsedNextBestAction | null = null;
    let inferenceEcho: AgentInferenceEcho | null = null;
    let note: string;

    if (!configured) {
      note =
        'Inference not configured — returning the federated signal snapshot only (connect inference to recommend).';
    } else if (!gate.allowed) {
      note = `Not entitled to run the next-best-action agent: ${gate.reason}`;
    } else {
      const result = await this.inference.complete(infCtx, {
        task: 'next-best-action',
        tier,
        responseFormat: 'json',
        temperature: 0.3,
        maxOutputTokens: 600,
        messages: this.buildPrompt(signals),
      });
      if (!result) {
        note = 'Inference gateway did not return a result — returning the signal snapshot only.';
      } else {
        inferenceEcho = this.echo(result);
        parsed = this.parse(result.text);
        note = parsed?.nextAction
          ? `Recommended next action (priority ${parsed.priority ?? 'n/a'}).`
          : 'Inference returned an unparseable recommendation — returning the signal snapshot only.';
      }
    }

    // 4) LOG the agent run (RLS tx) — the audit trail that the agent ran. No PII.
    await this.logRun(user, customerId, requestedWorkspaceId, note, inferenceEcho);

    return {
      customerId,
      contactId: rel.contactId,
      agent: 'next-best-action',
      inferenceConfigured: configured,
      entitled: gate.allowed,
      tierUsed: inferenceEcho ? (inferenceEcho.metered ? 'metered' : 'bundled') : null,
      inference: inferenceEcho,
      draftOnly: true,
      note,
      nextAction: parsed?.nextAction ?? null,
      rationale: parsed?.rationale ?? null,
      priority: parsed?.priority ?? null,
      confidence: parsed?.confidence ?? null,
      signals,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async loadRelationship(tx: WorkspaceTxClient, customerId: string) {
    const row = await tx.customer.findUnique({ where: { id: customerId } });
    if (!row) throw new NotFoundException(`Customer ${customerId} not found`);
    return row;
  }

  private buildPrompt(signals: NextBestActionSignals) {
    const system =
      'You are a B2B relationship next-best-action advisor inside a sales cockpit. ' +
      'Given a snapshot of a customer relationship and its federated engagement / ' +
      'meeting / outreach signal, recommend the SINGLE most valuable next step a rep ' +
      'should take to move the relationship forward. Prefer a concrete, specific step ' +
      '(e.g. "send the enterprise quote", "book a follow-up call about the open action ' +
      'item") grounded in the signal — do NOT invent facts. You do NOT take any action ' +
      '— you only recommend; a human decides. Respond with STRICT JSON only, no prose ' +
      'outside the JSON, matching exactly: {"nextAction": "<one concrete step>", ' +
      '"rationale": "<2-3 sentences>", "priority": "low"|"medium"|"high", "confidence": ' +
      '<number 0-1>}. Weight recent two-way engagement and open action items toward a ' +
      'higher priority; weight staleness with no engagement toward a re-engagement step.';
    const user =
      'Relationship signal:\n' +
      JSON.stringify(signals, null, 2) +
      '\nReturn the JSON recommendation.';
    return [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
  }

  private parse(text: string): ParsedNextBestAction | null {
    const obj = safeJsonObject(text);
    if (!obj) return null;
    const nextAction = strOrNull(obj['nextAction']);
    const rationale = strOrNull(obj['rationale']);
    const prRaw = String(obj['priority'] ?? '').toLowerCase();
    const priority =
      prRaw === 'low' || prRaw === 'medium' || prRaw === 'high'
        ? (prRaw as 'low' | 'medium' | 'high')
        : null;
    const confRaw = obj['confidence'];
    const confidence =
      typeof confRaw === 'number' && Number.isFinite(confRaw)
        ? Math.max(0, Math.min(1, confRaw))
        : null;
    return { nextAction, rationale, priority, confidence };
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
            body: `next-best-action agent ran — ${note}${lane}`,
            actorUcUid: ucUidOf(user) || null,
          },
        });
      },
      requestedWorkspaceId,
    );
  }
}

interface ParsedNextBestAction {
  nextAction: string | null;
  rationale: string | null;
  priority: 'low' | 'medium' | 'high' | null;
  confidence: number | null;
}
