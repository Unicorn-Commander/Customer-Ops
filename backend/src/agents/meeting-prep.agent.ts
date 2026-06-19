/**
 * MeetingPrepAgent (Phase 5+) — produce a prep brief for an upcoming meeting with
 * a customer's contact, from federated context.
 *
 * The agent COMPOSES (it does not own any data):
 *   - the LOCAL relationship (RLS tx; stage, notes),
 *   - the FEDERATED Contact-Ops contact (display name — read-time, never stored),
 *   - the FEDERATED Meeting-Ops history (meeting count, last meeting + title, open
 *     action items, the freshest summary headline) — the conversation signal,
 *   - the FEDERATED Accounting-Ops invoice panel (open-balance context, live status
 *     via the Phase-3 path) + the FEDERATED Outreach last touch (engagement),
 * then hands a prompt to the 4-lane inference seam (AgentInferencePort) and parses
 * a STRUCTURED prep brief (talking points + open items + a suggested agenda + a
 * short summary). It logs ONE CustomerActivity(AGENT_RUN) and returns the brief.
 *
 * NO SIDE EFFECTS (binding): this agent only READS + DRAFTS a brief. It NEVER books
 * a meeting, posts an agenda anywhere, sends mail, or moves a stage. The brief is
 * for a human to use; nothing is acted on. `draftOnly:true` is asserted on the
 * result.
 *
 * DEGRADE-CLEAN: when the inference gateway is not configured (or the caller is not
 * entitled), the agent still assembles + returns the federated signal snapshot
 * (context for the cockpit) with empty arrays + a null summary + a note — it never
 * throws and never blocks. Federation reads are individually best-effort (a dormant
 * Meeting-Ops / Accounting-Ops / Outreach just yields zeros/nulls).
 *
 * ENTITLEMENT: gated through AgentInferencePort.checkEntitlement (the 4-lane
 * model — `customer-ops` for the bundled lane). The inference lane is SELECTABLE
 * (caller `tier` override > AGENT_MEETING_PREP_TIER env > 'bundled'; see
 * agent-tier.util.ts); it defaults to BUNDLED (a relationship agent in the seat
 * price, lanes 1-2), so it does not require `ai-metered` unless 'metered' is
 * selected (which the gate then gates on it). Reading the invoice panel is
 * viewer-level on Accounting-Ops (the Phase-3 path enforces the AR affordances).
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
import { FederatedActionItem } from '../meeting-ops/meeting-ops.types';
import { CustomersService } from '../customers/customers.service';
import { AgentInferencePort, InferenceContext } from './inference/agent-inference.port';
import { AgentInferenceEcho, MeetingPrepResult, MeetingPrepSignals } from './agents.types';
import { AgentInferenceResult, InferenceTier } from './inference/agent-inference.types';
import { safeJsonObject, strArray, strOrNull } from './agent-parse.util';

/** How many open action-item texts to fold into the prep signal (cap-bounded). */
const OPEN_ACTION_ITEM_CAP = 8;

@Injectable()
export class MeetingPrepAgent {
  private readonly logger = new Logger(MeetingPrepAgent.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly meetingOps: MeetingOpsPort,
    private readonly outreach: OutreachPort,
    private readonly inference: AgentInferencePort,
    // Reused for the FEDERATED invoice panel (Phase-3 AO poll path). Read-only.
    private readonly customers: CustomersService,
  ) {}

  /**
   * Produce a meeting-prep brief for one customer-relationship: gather the meeting
   * history + open action items + invoice/outreach context, ask for a structured
   * brief, log AGENT_RUN, return the brief. No side effects.
   */
  async prep(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
    tier: InferenceTier = 'bundled',
  ): Promise<MeetingPrepResult> {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);

    // 1) LOCAL relationship (RLS tx; 404 if absent in the workspace).
    const rel = await this.workspaces.runForUser(
      user,
      (tx) => this.loadRelationship(tx, customerId),
      requestedWorkspaceId,
    );

    // 2) FEDERATE the context (best-effort; degrade-clean). Outside the DB tx.
    const fedCtx = { workspaceId, ucUid: ucUid || null };
    const [contact, meetingSignal, actionItems, touches, panel] = await Promise.all([
      this.contactOps.getContact(fedCtx, rel.contactId).catch(() => null),
      this.meetingOps.getMeetingSignal(fedCtx, rel.contactId).catch(() => null),
      this.meetingOps.isConfigured()
        ? this.meetingOps
            .listActionItemsForContact(fedCtx, rel.contactId, { limit: 25 })
            .catch((): FederatedActionItem[] => [])
        : Promise.resolve<FederatedActionItem[]>([]),
      this.outreach.isConfigured()
        ? this.outreach
            .listTouchesForContact(
              { workspaceId, ucUid: ucUid || null, entitlements: entitlementsOf(user) },
              rel.contactId,
            )
            .catch((): OutreachTouch[] => [])
        : Promise.resolve<OutreachTouch[]>([]),
      this.customers.invoicesForUser(user, customerId, requestedWorkspaceId).catch(() => null),
    ]);

    // The open action items (Meeting-Ops status open|in_progress), capped.
    const openActionItems = actionItems
      .filter((ai) => {
        const s = String(ai.status ?? '').toLowerCase();
        return s === 'open' || s === 'in_progress';
      })
      .map((ai) => ai.text)
      .filter((t): t is string => !!t && !!t.trim())
      .slice(0, OPEN_ACTION_ITEM_CAP);

    // The most-recent outreach touch, if any.
    const lastTouch = touches.length
      ? touches.reduce((a, b) => ((b.sentAt ?? '') > (a.sentAt ?? '') ? b : a))
      : null;

    // Open-invoice context (sent/partial, positive balance). Viewer-level read.
    const openItems = (panel?.items ?? []).filter((it: Record<string, any>) => {
      const status = String(it.status ?? '').toLowerCase();
      return (status === 'sent' || status === 'partial') && Number(it.balanceDue ?? 0) > 0;
    });
    const totalOpenBalance = openItems.length
      ? openItems.reduce((sum, it) => sum + Number(it.balanceDue ?? 0), 0).toFixed(2)
      : null;

    const signals: MeetingPrepSignals = {
      stage: rel.stage,
      contactDisplayName: contact?.displayName ?? null,
      relationshipNotes: rel.notes ?? null,
      meetingCount: meetingSignal?.meetingCount ?? 0,
      lastMeetingAt: meetingSignal?.lastMeetingAt ?? null,
      lastMeetingTitle: meetingSignal?.lastMeetingTitle ?? null,
      openActionItemCount: meetingSignal?.openActionItemCount ?? 0,
      latestSummaryHeadline: meetingSignal?.latestSummaryHeadline ?? null,
      openActionItems,
      openInvoiceCount: openItems.length,
      totalOpenBalance,
      lastOutreachSubject: lastTouch?.subject ?? null,
      lastEngagementKind: lastTouch?.lastEngagementKind ?? null,
    };

    // 3) ENTITLEMENT + INFERENCE (the SELECTABLE tier — defaults to 'bundled').
    const infCtx: InferenceContext = {
      workspaceId,
      ucUid: ucUid || null,
      entitlements: entitlementsOf(user),
    };
    const gate = this.inference.checkEntitlement(infCtx, tier);
    const configured = this.inference.isConfigured();

    let parsed: ParsedMeetingPrep | null = null;
    let inferenceEcho: AgentInferenceEcho | null = null;
    let note: string;

    if (!configured) {
      note =
        'Inference not configured — returning the federated signal snapshot only (connect inference to prep).';
    } else if (!gate.allowed) {
      note = `Not entitled to run the meeting-prep agent: ${gate.reason}`;
    } else {
      const result = await this.inference.complete(infCtx, {
        task: 'meeting-prep',
        tier,
        responseFormat: 'json',
        temperature: 0.4,
        maxOutputTokens: 900,
        messages: this.buildPrompt(signals),
      });
      if (!result) {
        note = 'Inference gateway did not return a result — returning the signal snapshot only.';
      } else {
        inferenceEcho = this.echo(result);
        parsed = this.parse(result.text);
        note = parsed
          ? `Prep brief ready (${parsed.talkingPoints.length} talking point(s), ${parsed.suggestedAgenda.length} agenda item(s)).`
          : 'Inference returned an unparseable brief — returning the signal snapshot only.';
      }
    }

    // 4) LOG the agent run (RLS tx) — the audit trail that the agent ran. No PII.
    await this.logRun(user, customerId, requestedWorkspaceId, note, inferenceEcho);

    return {
      customerId,
      contactId: rel.contactId,
      agent: 'meeting-prep',
      inferenceConfigured: configured,
      entitled: gate.allowed,
      tierUsed: inferenceEcho ? (inferenceEcho.metered ? 'metered' : 'bundled') : null,
      inference: inferenceEcho,
      draftOnly: true,
      note,
      talkingPoints: parsed?.talkingPoints ?? [],
      openItems: parsed?.openItems ?? [],
      suggestedAgenda: parsed?.suggestedAgenda ?? [],
      summary: parsed?.summary ?? null,
      signals,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async loadRelationship(tx: WorkspaceTxClient, customerId: string) {
    const row = await tx.customer.findUnique({ where: { id: customerId } });
    if (!row) throw new NotFoundException(`Customer ${customerId} not found`);
    return row;
  }

  private buildPrompt(signals: MeetingPrepSignals) {
    const system =
      'You are a B2B meeting-prep assistant inside a relationship cockpit. Given a ' +
      'snapshot of a customer relationship + its federated meeting history, open ' +
      'action items, and invoice/outreach context, produce a concise prep brief for ' +
      'the rep ahead of their next meeting. Ground every point in the signal — do NOT ' +
      'invent facts (no fabricated names, dates, or commitments). You do NOT take any ' +
      'action — you only prepare the rep. Respond with STRICT JSON only, no prose ' +
      'outside the JSON, matching exactly: {"talkingPoints": ["..."], "openItems": ' +
      '["..."], "suggestedAgenda": ["..."], "summary": "<2-3 sentences>"}. Keep each ' +
      'array to a few crisp bullets; "openItems" are loose threads to close (open ' +
      'action items, an outstanding balance); "suggestedAgenda" is an ordered plan. ' +
      'DEPTH + GAPS: provide at least 3-4 talkingPoints, 2-3 openItems, and a 4-5 step ' +
      'ORDERED (numbered) suggestedAgenda — every bullet specific and grounded in the ' +
      'signal. When a field is null/0/missing (no contact email or name, 0 prior meetings, ' +
      '0 outreach touches, no expected value), SURFACE that gap explicitly in openItems and ' +
      'frame the brief as a first-touch / qualification meeting.';
    const user =
      'Relationship signal:\n' + JSON.stringify(signals, null, 2) + '\nReturn the JSON brief.';
    return [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
  }

  private parse(text: string): ParsedMeetingPrep | null {
    const obj = safeJsonObject(text);
    if (!obj) return null;
    const talkingPoints = strArray(obj['talkingPoints']);
    const openItems = strArray(obj['openItems']);
    const suggestedAgenda = strArray(obj['suggestedAgenda']);
    const summary = strOrNull(obj['summary']);
    // A brief with no content at all is treated as unparseable (caller shows the
    // snapshot only) — at least one populated field means we parsed something.
    if (!talkingPoints.length && !openItems.length && !suggestedAgenda.length && !summary) {
      return null;
    }
    return { talkingPoints, openItems, suggestedAgenda, summary };
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
            body: `meeting-prep agent ran — ${note}${lane}`,
            actorUcUid: ucUidOf(user) || null,
          },
        });
      },
      requestedWorkspaceId,
    );
  }
}

interface ParsedMeetingPrep {
  talkingPoints: string[];
  openItems: string[];
  suggestedAgenda: string[];
  summary: string | null;
}
