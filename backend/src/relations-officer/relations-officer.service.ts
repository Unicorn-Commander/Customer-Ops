/**
 * RelationsOfficerService — the conversational orchestrator's logic.
 *
 * The Relations Officer is the cockpit's CONVERSATIONAL surface (the orchestrator
 * persona). It talks to the user grounded in their workspace and runs in one of
 * two modes:
 *
 *   - ADVISOR  — reads + recommends only. Any write the model emits is dropped.
 *   - OPERATOR — MAY propose exactly ONE relationship write when the user clearly
 *     asks. The proposal is validated into a single-use pending action the user
 *     must CONFIRM before anything executes.
 *
 * SAFETY (the proven suite "Guide" pattern — binding): the model PROPOSES a write
 * → the service VALIDATES it (kind + args + a target customer) → mints a SINGLE-USE
 * pending action (uuid, 5-min TTL, bound to the proposing user + workspace) →
 * returns only a safe projection → the user confirms → `confirmAction` consumes it
 * (delete-on-use) and executes it AS the user via the matching CustomersService
 * write (which already audits via a customer activity). Reads + recommendations
 * NEVER need confirmation; writes ALWAYS do.
 *
 * SCOPE (binding): the operator can ONLY do the 4 relationship writes
 * CustomersService owns — transition_stage / add_note / mark_lost / reopen. There
 * is NO invoice/email/send/charge path here, by construction (no such kind exists).
 * If asked for one, the persona declines / deep-links; it can never execute money
 * or mail. Secrets are never logged.
 *
 * DEGRADE-CLEAN (binding): when the inference gateway is not configured, `chat`
 * returns a clean "connect inference" reply with `proposedAction:null` (never a
 * 500). Federation/grounding reads are best-effort — a failed customer-360 still
 * yields a usable (if thinner) reply.
 *
 * STORE NOTE (v1): the pending-action store is an in-memory Map. That is correct
 * for a single replica only; a DB-backed (or Redis) store is the hardening
 * follow-up so a pending confirm survives a restart / works across replicas.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RelationshipStage, User } from '@prisma/client';
import { CustomersService } from '../customers/customers.service';
import { AgentInferencePort, InferenceContext } from '../agents/inference/agent-inference.port';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import {
  WithWorkspaceClaim,
  entitlementsOf,
  ucUidOf,
} from '../common/workspace/workspace.util';
import { safeJsonObject, strOrNull } from '../agents/agent-parse.util';
import {
  PendingAction,
  ProposedAction,
  RelationsOfficerActionArgs,
  RelationsOfficerActionKind,
  RelationsOfficerChatResult,
  RelationsOfficerConfirmResult,
  RelationsOfficerMessage,
  RelationsOfficerMode,
} from './relations-officer.types';

/** Single-use pending-action TTL — 5 minutes (matches the suite Guide pattern). */
const PENDING_TTL_MS = 5 * 60 * 1000;

/** The 4 writes the operator may propose — the allow-list the validator gates on.
 *  NO invoice/email/send/charge kind exists here, so none can ever be proposed. */
const ALLOWED_KINDS: ReadonlySet<RelationsOfficerActionKind> = new Set([
  'transition_stage',
  'add_note',
  'mark_lost',
  'reopen',
]);

type AuthedUser = User & Partial<WithWorkspaceClaim>;

@Injectable()
export class RelationsOfficerService {
  private readonly logger = new Logger(RelationsOfficerService.name);

  /**
   * The single-use pending-action store. v1: in-memory, single-replica only.
   * Hardening follow-up = a DB/Redis-backed store (survives restart, multi-replica).
   * Keyed by the action's uuid; entries are consumed (deleted) on use + swept lazily.
   */
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    private readonly customers: CustomersService,
    private readonly inference: AgentInferencePort,
    private readonly workspaces: WorkspaceContextService,
  ) {}

  // ========================================================================
  // POST /chat — converse, ground, and (operator mode) maybe PROPOSE a write.
  // ========================================================================

  async chat(
    user: AuthedUser,
    requestedWorkspaceId: string | null | undefined,
    body: {
      messages: RelationsOfficerMessage[];
      mode: RelationsOfficerMode;
      customerId?: string | null;
    },
  ): Promise<RelationsOfficerChatResult> {
    const mode: RelationsOfficerMode = body.mode === 'operator' ? 'operator' : 'advisor';
    const customerId = body.customerId?.trim() || null;
    const configured = this.inference.isConfigured();

    // DEGRADE-CLEAN: no gateway → a clean, side-effect-free affordance (never 500).
    if (!configured) {
      return {
        reply:
          'I cannot think this through yet — no inference gateway is connected for ' +
          'this workspace. Connect inference (set AGENT_INFERENCE_BASE_URL) and I can ' +
          'pick this back up. I never act on my own; when I am back I will still ' +
          'propose and let you decide.',
        mode,
        customerId,
        proposedAction: null,
        inferenceConfigured: false,
      };
    }

    // Build the grounding context (best-effort). A grounded customer gets a compact
    // customer-360; otherwise a short pipeline summary.
    const grounding = await this.buildGrounding(user, customerId, requestedWorkspaceId);

    const infCtx: InferenceContext = {
      workspaceId: await this.workspaces.resolveAuthorized(user, requestedWorkspaceId),
      ucUid: ucUidOf(user) || null,
      entitlements: entitlementsOf(user),
    };

    const messages = [
      { role: 'system' as const, content: this.systemPrompt(mode, grounding) },
      ...body.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const result = await this.inference.complete(infCtx, {
      // The orchestrator rides the existing bundled relationship-agent lane.
      task: 'next-best-action',
      tier: 'bundled',
      responseFormat: 'json',
      temperature: 0.3,
      maxOutputTokens: 900,
      messages,
    });

    if (!result) {
      // Configured but the call failed / was not entitled — degrade-clean.
      return {
        reply:
          'I could not complete that just now — the reasoning lane did not respond. ' +
          'Please try again in a moment. Nothing was changed.',
        mode,
        customerId,
        proposedAction: null,
        inferenceConfigured: true,
      };
    }

    const parsed = this.parseModelOutput(result.text);
    const reply =
      parsed.reply ||
      'I am here and grounded in your workspace. Tell me what you would like to look ' +
        'at or do, and I will propose a step for you to confirm.';

    // ADVISOR: never propose a write — drop any action the model emitted.
    if (mode === 'advisor') {
      return {
        reply,
        mode,
        customerId,
        proposedAction: null,
        inferenceConfigured: true,
      };
    }

    // OPERATOR: a write may be proposed, but ONLY with a target customer + a valid
    // kind/args. Everything else returns a plain reply (no proposal).
    if (!parsed.action) {
      return { reply, mode, customerId, proposedAction: null, inferenceConfigured: true };
    }

    if (!customerId) {
      return {
        reply:
          (reply ? reply + '\n\n' : '') +
          'I can set that up, but I need to know which customer it applies to. Open the ' +
          'relationship (or tell me which one) and ask me again.',
        mode,
        customerId,
        proposedAction: null,
        inferenceConfigured: true,
      };
    }

    const validated = this.validateAction(parsed.action.kind, parsed.action.args);
    if (!validated.ok) {
      return {
        reply:
          (reply ? reply + '\n\n' : '') +
          `I started to propose an action but it was not something I can safely do (${validated.reason}). ` +
          'I can move a relationship a stage, add a note, mark it lost, or re-open it — ' +
          'tell me which and I will propose it.',
        mode,
        customerId,
        proposedAction: null,
        inferenceConfigured: true,
      };
    }

    const proposedAction = this.createPending(
      infCtx.workspaceId,
      ucUidOf(user) || '',
      customerId,
      validated.kind,
      validated.args,
    );

    return {
      reply:
        reply ||
        `Here is what I would do: ${proposedAction.label}. Confirm and I will carry it out; ` +
          'cancel and nothing changes.',
      mode,
      customerId,
      proposedAction,
      inferenceConfigured: true,
    };
  }

  // ========================================================================
  // POST /confirm-action — consume a single-use pending write + execute it.
  // ========================================================================

  async confirmAction(
    user: AuthedUser,
    requestedWorkspaceId: string | null | undefined,
    body: { actionId: string; decision: 'confirm' | 'cancel' },
  ): Promise<RelationsOfficerConfirmResult> {
    const actionId = body.actionId?.trim();
    const decision = body.decision === 'confirm' ? 'confirm' : 'cancel';

    this.sweepExpired();
    const pending = actionId ? this.pending.get(actionId) : undefined;

    // Missing / already-consumed / unknown id.
    if (!pending) {
      return {
        executed: false,
        message:
          'That action is no longer available — it may have already been used, cancelled, ' +
          'or expired. Ask me again and I will propose a fresh one.',
      };
    }

    // SINGLE-USE: consume it immediately (delete-on-use) so it can never run twice,
    // regardless of the decision branch below.
    this.pending.delete(actionId);

    // Bind check: the confirm must come from the SAME user + workspace that proposed
    // it. (Defense-in-depth on top of the membership guard.)
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const userKey = ucUidOf(user) || '';
    if (pending.userKey !== userKey || pending.workspaceId !== workspaceId) {
      this.logger.warn(
        `Relations Officer confirm rejected: action ${actionId} does not belong to the ` +
          `confirming user/workspace.`,
      );
      return {
        executed: false,
        message: 'That action does not belong to you here, so I will not run it.',
      };
    }

    // Expired between propose + confirm.
    if (Date.now() > pending.expiresAt) {
      return {
        executed: false,
        message: 'That action expired before it was confirmed. Ask me again for a fresh one.',
      };
    }

    if (decision === 'cancel') {
      return { executed: false, message: 'Cancelled — nothing was changed.' };
    }

    // CONFIRM: execute AS the user via the matching CustomersService write (which
    // already audits via a customer activity). Each path re-validates its args.
    try {
      const result = await this.execute(user, requestedWorkspaceId, pending);
      return {
        executed: true,
        kind: pending.kind,
        result,
        message: this.confirmedMessage(pending),
      };
    } catch (err) {
      // The write rejected (e.g. an illegal funnel move, already-lost). Surface it
      // cleanly — the action is already consumed, so the user re-asks for a fresh one.
      const reason = err instanceof Error ? err.message : 'the write could not be completed';
      this.logger.warn(`Relations Officer execute failed for ${pending.kind}: ${reason}`);
      return {
        executed: false,
        kind: pending.kind,
        message: `I could not complete that: ${reason}. Nothing else was changed.`,
      };
    }
  }

  // ========================================================================
  // GROUNDING — a COMPACT customer-360 summary, or a short pipeline summary.
  // ========================================================================

  /** Build the (small, capped) grounding string put into the system message. */
  private async buildGrounding(
    user: AuthedUser,
    customerId: string | null,
    requestedWorkspaceId: string | null | undefined,
  ): Promise<string> {
    if (customerId) {
      try {
        const c360 = await this.customers.customer360ForUser(
          user,
          customerId,
          requestedWorkspaceId,
        );
        return this.condenseCustomer(c360);
      } catch (err) {
        this.logger.warn(
          `Relations Officer grounding (customer ${customerId}) failed: ${
            (err as Error).message
          }`,
        );
        return `The selected customer (${customerId}) could not be loaded right now; answer generally and suggest re-opening it.`;
      }
    }
    try {
      return await this.condensePipeline(user, requestedWorkspaceId);
    } catch (err) {
      this.logger.warn(`Relations Officer pipeline grounding failed: ${(err as Error).message}`);
      return 'The pipeline could not be loaded right now; answer generally.';
    }
  }

  /** Condense a customer-360 into a small grounding summary (stage, contact, value,
   *  panel counts, next action). Kept deliberately compact to bound the prompt. */
  private condenseCustomer(c360: ReturnType<CustomersService['customer360ForUser']> extends Promise<infer R> ? R : never): string {
    const rel = c360.relationship;
    const contact = c360.contact;
    const name = contact?.displayName ?? '(unresolved contact)';
    const email = contact?.primaryEmail ?? 'no email on file';
    const value = rel.expectedValue != null ? rel.expectedValue : 'n/a';
    const nextAction = rel.nextActionAt ? new Date(rel.nextActionAt).toISOString().slice(0, 10) : 'none set';

    const invoices = c360.invoices?.items?.length ?? 0;
    const meetings = c360.meetings?.meetings?.length ?? 0;
    const openActionItems = c360.meetings?.actionItems?.length ?? 0;
    const emailThreads = c360.email?.threads?.length ?? 0;
    const outreachTouches = c360.outreach?.touches?.length ?? 0;
    const projects = c360.projects?.projects?.length ?? 0;
    const timeline = c360.timeline?.length ?? 0;

    const lostLine = rel.isLost
      ? `Status: CLOSED-LOST (${rel.lostReason ?? 'no reason recorded'}).`
      : 'Status: open.';

    return [
      'GROUNDING — the customer in focus (condensed; these are the only live facts you have):',
      `- Customer id: ${rel.id}`,
      `- Contact: ${name} <${email}>`,
      `- Stage: ${rel.stage} · Priority: ${rel.priority}`,
      `- ${lostLine}`,
      `- Expected value: ${value} ${rel.currency ?? ''}`.trim(),
      `- Next action: ${nextAction}`,
      `- Panels — invoices: ${invoices}, meetings: ${meetings} (open action items: ${openActionItems}), ` +
        `email threads: ${emailThreads}, outreach touches: ${outreachTouches}, projects: ${projects}, ` +
        `timeline entries: ${timeline}.`,
    ].join('\n');
  }

  /** Condense the pipeline into a short summary: per-stage counts + a few attention
   *  items (oldest-in-stage, highest priority). */
  private async condensePipeline(
    user: AuthedUser,
    requestedWorkspaceId: string | null | undefined,
  ): Promise<string> {
    // Skip the (heavier) contact federation — counts + a little attention signal
    // is enough grounding, and keeps the prompt small.
    const pipeline = await this.customers.pipelineForUser(user, requestedWorkspaceId, false);
    const laneLines = pipeline.lanes.map(
      (l) => `  - ${l.stage}: ${l.count} (expected value ${l.expectedValue})`,
    );

    // A few attention items: the first card in each non-empty lane (the board is
    // ordered priority desc, then oldest stage change first).
    const attention: string[] = [];
    for (const lane of pipeline.lanes) {
      const card = lane.cards[0];
      if (!card) continue;
      const label = card.contact?.displayName ?? card.contactId;
      attention.push(`  - ${lane.stage}: ${label} (priority ${card.priority}, id ${card.id})`);
      if (attention.length >= 5) break;
    }

    return [
      'GROUNDING — the workspace pipeline (condensed; these are the only live facts you have):',
      `Totals: ${pipeline.totals.count} open relationships, expected value ${pipeline.totals.expectedValue}.`,
      'By stage:',
      ...laneLines,
      attention.length ? 'A few needing attention:' : 'No open relationships to highlight.',
      ...attention,
      'No single customer is in focus — to propose an action, ask the user to open one.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ========================================================================
  // PERSONA — the Relations Officer system prompt.
  // ========================================================================

  private systemPrompt(mode: RelationsOfficerMode, grounding: string): string {
    const persona = [
      'You are the Relations Officer: the conversational surface of a relationship cockpit.',
      'You speak relationally, plainly, and like a calm colleague — never breathless marketing.',
      'Your stance is sovereign and clear: "I propose, you decide." You never act on your own.',
      'You are a SURFACE, not an engine. You do NOT claim to be the phonebook, the billing system,',
      'a mail server, or a CRM database — those are other systems you sit on top of. You reason over',
      'the grounding you are given and recommend the next human step.',
      '',
      'You are grounded ONLY in the facts in the GROUNDING block below. Do not invent customers,',
      'numbers, meetings, or invoices. If you do not have a fact, say so and suggest where to look',
      '(e.g. open the relationship, run the lead-triage / next-best-action / meeting-prep / follow-up',
      '/ collections-nudge sub-agent). Recommending which sub-agent to run is encouraged.',
      '',
      'FORBIDDEN WORDS — never use: revolutionary, game-changer, synergize, unleash, velocity,',
      'supercharge, AI-powered. Write like a person, not a brochure.',
    ];

    const modeBlock =
      mode === 'operator'
        ? [
            'MODE: OPERATOR. You read, recommend, AND — only when the user clearly asks you to change',
            'the relationship — you may PROPOSE exactly ONE write for them to confirm. You never execute;',
            'a proposal becomes a Confirm/Cancel card the user must approve. Propose AT MOST one action',
            'per reply, and only when the user clearly asked for it; otherwise set "action" to null.',
            'The ONLY writes you may propose are these four relationship-lifecycle changes:',
            '  - transition_stage  args: { "toStage": "LEAD" | "PROSPECT" | "CUSTOMER" }',
            '  - add_note          args: { "body": "<the note text>" }',
            '  - mark_lost         args: { "reason": "<why it is closed-lost>" }',
            '  - reopen            args: {}',
            'You CANNOT send email, create or send invoices, charge a card, or move money — those are',
            'out of scope. If the user asks for one, decline plainly and point them to the right surface',
            '(the invoices panel / the email panel); set "action" to null.',
          ]
        : [
            'MODE: ADVISOR. You read and recommend ONLY. You do NOT propose or take any write — always',
            'set "action" to null. When the user wants to change something, explain what you would',
            'recommend and tell them they can switch you to operator mode (or use the cockpit) to do it.',
          ];

    const format = [
      'Respond with STRICT JSON only — no prose outside the JSON — matching exactly:',
      '{"reply": "<your message to the user>", "action": null | {"kind": "transition_stage"|"add_note"|"mark_lost"|"reopen", "args": { ... }}}',
      'Put everything you want the user to read in "reply". Use "action" only to propose a write (operator',
      'mode only); otherwise it MUST be null.',
    ];

    return [persona.join('\n'), modeBlock.join('\n'), grounding, format.join('\n')].join('\n\n');
  }

  // ========================================================================
  // VALIDATION + PENDING STORE + EXECUTION
  // ========================================================================

  /** Validate the model's proposed kind + args into a safe, typed action. Rejects
   *  any kind outside the allow-list and any missing/oversized args. */
  private validateAction(
    kind: unknown,
    rawArgs: unknown,
  ):
    | { ok: true; kind: RelationsOfficerActionKind; args: RelationsOfficerActionArgs }
    | { ok: false; reason: string } {
    const k = typeof kind === 'string' ? (kind.trim() as RelationsOfficerActionKind) : null;
    if (!k || !ALLOWED_KINDS.has(k)) {
      return { ok: false, reason: `unknown action "${String(kind)}"` };
    }
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;

    if (k === 'transition_stage') {
      const toStage = String(args['toStage'] ?? '').trim().toUpperCase();
      const valid =
        toStage === RelationshipStage.LEAD ||
        toStage === RelationshipStage.PROSPECT ||
        toStage === RelationshipStage.CUSTOMER;
      if (!valid) return { ok: false, reason: `"${toStage}" is not a valid stage` };
      return { ok: true, kind: k, args: { toStage } };
    }

    if (k === 'add_note') {
      const bodyText = strOrNull(args['body']);
      if (!bodyText) return { ok: false, reason: 'a note needs a body' };
      if (bodyText.length > 4000) return { ok: false, reason: 'the note is too long' };
      return { ok: true, kind: k, args: { body: bodyText } };
    }

    if (k === 'mark_lost') {
      const reason = strOrNull(args['reason']);
      if (!reason) return { ok: false, reason: 'marking lost needs a reason' };
      if (reason.length > 500) return { ok: false, reason: 'the reason is too long' };
      return { ok: true, kind: k, args: { reason } };
    }

    // reopen — no args.
    return { ok: true, kind: k, args: {} };
  }

  /** Mint + store a single-use pending action and return its safe projection. */
  private createPending(
    workspaceId: string,
    userKey: string,
    customerId: string,
    kind: RelationsOfficerActionKind,
    args: RelationsOfficerActionArgs,
  ): ProposedAction {
    this.sweepExpired();
    const id = randomUUID();
    const pending: PendingAction = {
      id,
      userKey,
      workspaceId,
      customerId,
      kind,
      args,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    this.pending.set(id, pending);
    const { label, detail } = this.describe(kind, args);
    return { id, kind, label, detail, customerId };
  }

  /** Execute a confirmed action AS the user via the matching CustomersService write
   *  (each already audits via a customer activity). */
  private async execute(
    user: AuthedUser,
    requestedWorkspaceId: string | null | undefined,
    pending: PendingAction,
  ): Promise<unknown> {
    switch (pending.kind) {
      case 'transition_stage':
        return this.customers.transitionForUser(
          user,
          pending.customerId,
          { toStage: pending.args.toStage as RelationshipStage },
          requestedWorkspaceId,
        );
      case 'add_note':
        return this.customers.addNoteForUser(
          user,
          pending.customerId,
          { body: pending.args.body as string },
          requestedWorkspaceId,
        );
      case 'mark_lost':
        return this.customers.markLostForUser(
          user,
          pending.customerId,
          { reason: pending.args.reason as string },
          requestedWorkspaceId,
        );
      case 'reopen':
        return this.customers.reopenForUser(user, pending.customerId, requestedWorkspaceId);
    }
  }

  /** A human label + detail for a proposed action (the Confirm/Cancel card). */
  private describe(
    kind: RelationsOfficerActionKind,
    args: RelationsOfficerActionArgs,
  ): { label: string; detail: string } {
    switch (kind) {
      case 'transition_stage':
        return {
          label: `Move to ${args.toStage}`,
          detail: `Move this relationship to the ${args.toStage} stage (the timeline records the change).`,
        };
      case 'add_note':
        return {
          label: 'Add a note',
          detail: `Append this note to the relationship timeline: "${this.clip(args.body ?? '', 140)}"`,
        };
      case 'mark_lost':
        return {
          label: 'Mark closed-lost',
          detail: `Mark this relationship closed-lost. Reason: "${this.clip(args.reason ?? '', 140)}"`,
        };
      case 'reopen':
        return {
          label: 'Re-open',
          detail: 'Re-open this closed-lost relationship (clears the lost flag).',
        };
    }
  }

  /** The post-execution confirmation message for the user. */
  private confirmedMessage(pending: PendingAction): string {
    switch (pending.kind) {
      case 'transition_stage':
        return `Done — moved to ${pending.args.toStage}.`;
      case 'add_note':
        return 'Done — your note is on the timeline.';
      case 'mark_lost':
        return 'Done — marked closed-lost.';
      case 'reopen':
        return 'Done — re-opened.';
    }
  }

  /** Parse the model's JSON output into { reply, action } defensively. */
  private parseModelOutput(text: string): {
    reply: string;
    action: { kind: RelationsOfficerActionKind; args: RelationsOfficerActionArgs } | null;
  } {
    const obj = safeJsonObject(text);
    if (!obj) {
      // Unparseable — treat the whole thing as the reply (no proposal).
      return { reply: strOrNull(text) ?? '', action: null };
    }
    const reply = strOrNull(obj['reply']) ?? '';
    const rawAction = obj['action'];
    if (!rawAction || typeof rawAction !== 'object') {
      return { reply, action: null };
    }
    const a = rawAction as Record<string, unknown>;
    const kind = typeof a['kind'] === 'string' ? (a['kind'] as RelationsOfficerActionKind) : null;
    if (!kind) return { reply, action: null };
    const args = (a['args'] && typeof a['args'] === 'object' ? a['args'] : {}) as RelationsOfficerActionArgs;
    return { reply, action: { kind, args } };
  }

  /** Drop expired pending actions (lazy sweep on each propose/confirm). */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (now > p.expiresAt) this.pending.delete(id);
    }
  }

  private clip(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }
}
