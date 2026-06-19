/**
 * FollowUpDrafterAgent (Phase 5) — draft a follow-up email from federated context.
 *
 * The agent COMPOSES (it does not own any data):
 *   - the LOCAL relationship (RLS tx; stage, owner, notes),
 *   - the FEDERATED Contact-Ops contact (display name + primary email — resolved
 *     read-time, never stored),
 *   - the FEDERATED last touch (Outreach) + the FEDERATED Meeting-Ops signal
 *     (last meeting / freshest summary / open action items) as the "what to follow
 *     up about" material,
 * then hands a prompt to the 4-lane inference seam (AgentInferencePort) and parses
 * a STRUCTURED draft (subject + body). It logs ONE CustomerActivity(AGENT_RUN) and
 * returns the draft.
 *
 * NEVER AUTO-SENDS (binding): the agent returns a DRAFT. It can OPTIONALLY hand the
 * draft to the Email-Ops agent-inbox approval surface — but only via
 * EmailOpsPort.composeEmail with mode='draft' (reusing the Phase-4
 * CustomersService.sendEmailForUser path, which is idempotent + dual-SKU gated +
 * writes the thin link). mode='draft' STAGES the message for a human to approve;
 * it does NOT send. The agent NEVER passes mode='send'. `draftOnly:true` is
 * asserted on the result.
 *
 * DEGRADE-CLEAN: inference unconfigured / not entitled → the agent returns the
 * assembled recipient + context with a null subject/body + a note (no draft
 * produced), never throwing. Staging into Email-Ops is best-effort: if Email-Ops
 * is unconfigured / not entitled the draft is still returned to the caller (just
 * not staged), with the reason in the note.
 *
 * ENTITLEMENT: the inference call is gated through
 * AgentInferencePort.checkEntitlement (bundled tier; a relationship agent in the
 * seat price). The OPTIONAL Email-Ops staging is independently gated by the
 * Phase-4 customer-ops+email-ops dual SKU (enforced inside sendEmailForUser).
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
import { CustomersService } from '../customers/customers.service';
import { AgentInferencePort, InferenceContext } from './inference/agent-inference.port';
import { AgentInferenceEcho, FollowUpDraftResult } from './agents.types';
import { InferenceTier } from './inference/agent-inference.types';
import { safeJsonObject, strOrNull } from './agent-parse.util';

/** Options for a follow-up draft. `stageDraft` opts into staging the draft into
 *  the Email-Ops agent inbox (mode='draft', never a send). */
export interface FollowUpOptions {
  /** Operator's intent/angle for the follow-up (e.g. "nudge for the signed SOW"). */
  goal?: string;
  /** When true, ALSO stage the draft into the Email-Ops agent inbox for approval
   *  (mode='draft'). Default false — return the draft to the caller only. */
  stageDraft?: boolean;
  /** Idempotency key for the optional Email-Ops draft staging (forwarded). */
  idempotencyKey?: string;
}

@Injectable()
export class FollowUpDrafterAgent {
  private readonly logger = new Logger(FollowUpDrafterAgent.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly meetingOps: MeetingOpsPort,
    private readonly outreach: OutreachPort,
    private readonly inference: AgentInferencePort,
    // Reused for the OPTIONAL draft-staging step (mode='draft' only) — the exact
    // Phase-4 idempotent + dual-SKU-gated path. Never used to SEND.
    private readonly customers: CustomersService,
  ) {}

  async draftFollowUp(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    opts: FollowUpOptions = {},
    requestedWorkspaceId?: string | null,
    tier: InferenceTier = 'bundled',
  ): Promise<FollowUpDraftResult> {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);

    // 1) LOCAL relationship (RLS tx).
    const rel = await this.workspaces.runForUser(
      user,
      (tx) => this.loadRelationship(tx, customerId),
      requestedWorkspaceId,
    );

    // 2) FEDERATE the contact + the follow-up material (best-effort).
    const fedCtx = { workspaceId, ucUid: ucUid || null };
    const [contact, meetingSignal, touches, summaries] = await Promise.all([
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
      this.meetingOps.listSummariesForContact(fedCtx, rel.contactId, { limit: 2 }).catch(() => []),
    ]);

    const toAddress = contact?.primaryEmail ?? null;
    const lastTouch = touches.length
      ? touches.reduce((a, b) => ((b.sentAt ?? '') > (a.sentAt ?? '') ? b : a))
      : null;

    const context = {
      stage: rel.stage,
      goal: opts.goal ?? 'a friendly, specific check-in that moves the relationship forward',
      contactName: contact?.displayName ?? null,
      relationshipNotes: rel.notes ?? null,
      lastMeetingTitle: meetingSignal?.lastMeetingTitle ?? null,
      lastMeetingAt: meetingSignal?.lastMeetingAt ?? null,
      openActionItemCount: meetingSignal?.openActionItemCount ?? 0,
      latestSummaryHeadline: meetingSignal?.latestSummaryHeadline ?? null,
      latestSummaryBody: summaries[0]?.body ?? null,
      lastOutreachSubject: lastTouch?.subject ?? null,
      lastEngagement: lastTouch?.lastEngagementKind ?? null,
    };

    // 3) ENTITLEMENT + INFERENCE (the SELECTABLE tier — defaults to 'bundled').
    const infCtx: InferenceContext = {
      workspaceId,
      ucUid: ucUid || null,
      entitlements: entitlementsOf(user),
    };
    const gate = this.inference.checkEntitlement(infCtx, tier);
    const configured = this.inference.isConfigured();

    let subject: string | null = null;
    let body: string | null = null;
    let inferenceEcho: AgentInferenceEcho | null = null;
    let note: string;

    if (!configured) {
      note =
        'Inference not configured — assembled the recipient + context but produced no draft (connect inference to draft).';
    } else if (!gate.allowed) {
      note = `Not entitled to run the follow-up drafter: ${gate.reason}`;
    } else {
      const result = await this.inference.complete(infCtx, {
        task: 'follow-up-draft',
        tier,
        responseFormat: 'json',
        temperature: 0.5,
        maxOutputTokens: 900,
        messages: this.buildPrompt(context),
      });
      if (!result) {
        note = 'Inference gateway did not return a result — no draft produced.';
      } else {
        inferenceEcho = {
          lane: result.lane,
          model: result.model,
          metered: result.metered,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        };
        const parsed = safeJsonObject(result.text);
        subject = strOrNull(parsed?.['subject']);
        body = strOrNull(parsed?.['body']);
        note =
          subject && body ? 'Draft ready for review.' : 'Inference returned an unparseable draft.';
      }
    }

    // 4) OPTIONAL: stage the draft into the Email-Ops agent inbox (mode='draft'
    //    ONLY — never a send). Best-effort + independently dual-SKU gated; a
    //    failure leaves the draft returned to the caller (with the reason).
    let stagedDraft: FollowUpDraftResult['stagedDraft'] = null;
    if (opts.stageDraft && subject && body) {
      try {
        const staged = await this.customers.sendEmailForUser(
          user,
          customerId,
          {
            toAddress: toAddress ?? undefined,
            subject,
            body,
            mode: 'draft', // HARD-CODED draft — the agent NEVER sends.
            idempotencyKey: opts.idempotencyKey,
          },
          requestedWorkspaceId,
        );
        stagedDraft = {
          messageId: staged.message.id,
          threadId: staged.message.threadId ?? null,
          status: staged.message.status,
        };
        note += ' Staged into the Email-Ops agent inbox for approval (not sent).';
      } catch (err) {
        note += ` Could not stage into Email-Ops (${(err as Error).message}); draft returned to you instead.`;
      }
    }

    // 5) LOG the agent run (RLS tx).
    await this.logRun(user, customerId, requestedWorkspaceId, note, inferenceEcho);

    return {
      customerId,
      contactId: rel.contactId,
      agent: 'follow-up-draft',
      inferenceConfigured: configured,
      entitled: gate.allowed,
      tierUsed: inferenceEcho ? (inferenceEcho.metered ? 'metered' : 'bundled') : null,
      inference: inferenceEcho,
      draftOnly: true,
      note,
      subject,
      body,
      toAddress,
      stagedDraft,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private async loadRelationship(tx: WorkspaceTxClient, customerId: string) {
    const row = await tx.customer.findUnique({ where: { id: customerId } });
    if (!row) throw new NotFoundException(`Customer ${customerId} not found`);
    return row;
  }

  private buildPrompt(context: Record<string, unknown>) {
    const system =
      'You are a B2B relationship follow-up email drafter inside a sales cockpit. ' +
      'Given the relationship context and federated meeting/outreach signal, draft ' +
      'a concise, warm, specific follow-up email. Reference concrete details from ' +
      'the signal (a recent meeting topic, an open action item, the last touch) so ' +
      'it does not read generic. Do NOT invent facts not present in the context. ' +
      'You are drafting ONLY — a human will review and send. Respond with STRICT ' +
      'JSON only matching exactly: {"subject": "<short subject>", "body": "<plain-' +
      'text email body, no signature block>"}.';
    const user =
      'Relationship context:\n' + JSON.stringify(context, null, 2) + '\nReturn the JSON draft.';
    return [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
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
            body: `follow-up drafter agent ran — ${note}${lane}`,
            actorUcUid: ucUidOf(user) || null,
          },
        });
      },
      requestedWorkspaceId,
    );
  }
}
