import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { Prisma, User, WorkspaceRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf } from '../common/workspace/workspace.util';
import { EmailOpsPort, FederationContext } from '../email-ops/email-ops.port';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';
import { ProjectOpsPort } from '../project-ops/project-ops.port';
import { QuoteSnapshot, canonicalJson, computeQuote } from '../quotes-render/quote-model';
import { toPublishedQuoteView } from './quote-published-view';
import {
  AcceptOutcome,
  AcceptPayload,
  ConfirmOutcome,
  ConfirmPayload,
  PublicLookup,
  RequestMeta,
} from '../quotes-render/quotes-render.port';
import { prepareQuoteSnapshot } from './quote-snapshot';
import { QuotePresentationService } from './quote-presentation.service';
import {
  acceptanceCodeHash,
  acceptanceCodeMatches,
  idempotencyHash,
  newAcceptanceCode,
  newShareToken,
  sha256,
} from './quote-secrets';
import { quotesEnabled } from './quotes-enabled';

const failure = (status: number, code: string, detail: string) => ({
  ok: false as const,
  status,
  code,
  detail,
});
export class QuoteNotAvailable extends ServiceUnavailableException {
  constructor() {
    super({ code: 'QUOTE_NOT_AVAILABLE', message: 'This quote is not available yet.' });
  }
}
/** quotes.federated: the per-side fan-out status of an accepted quote. */
type FederatedStatus = {
  accounting_ops: string;
  project_ops: string;
  retries?: number;
  [key: string]: unknown;
};
/** Which sides reconcile() re-runs, and the stored status to keep for the rest. */
interface FederationRetry {
  accounting_ops: boolean;
  project_ops: boolean;
  prior: Record<string, unknown>;
}
/** reconcile() stops re-running a failed side after this many retries (logged). */
export const FEDERATION_MAX_RETRIES = 20;
/** Backoff before retry n+1: 2^n minutes, capped at 6 h (20 retries span days). */
const federationBackoffMs = (retries: number) => Math.min(2 ** retries, 360) * 60_000;
@Injectable()
export class QuotesLifecycleService {
  private readonly logger = new Logger(QuotesLifecycleService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspaceContextService,
    private readonly membership: MembershipService,
    private readonly email: EmailOpsPort,
    private readonly presentation: QuotePresentationService,
    private readonly audit: AuditService = new AuditService(workspaces),
    @Optional()
    @Inject(AccountingOpsPort)
    private readonly accounting: AccountingOpsPort | null = null,
    @Optional() @Inject(ProjectOpsPort) private readonly projects: ProjectOpsPort | null = null,
  ) {}
  private enabled() {
    if (!quotesEnabled(this.config.get<string>('QUOTES_ENABLED')))
      throw new ServiceUnavailableException('Quotes are not enabled');
  }
  private async authorized(user: User, ws?: string, write = true) {
    this.enabled();
    const workspace = await this.workspaces.resolveAuthorized(user, ws);
    if (
      write &&
      ![WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER].includes(
        (await this.membership.roleInWorkspace(user, workspace)) as any,
      )
    )
      throw new ForbiddenException('Workspace member role required');
    return workspace;
  }
  private async context(workspaceId: string, user?: User): Promise<FederationContext> {
    return {
      workspaceId,
      ucUid: user ? ucUidOf(user) : null,
      entitlements: user
        ? await this.workspaces.effectiveEntitlements(user, workspaceId)
        : ((await this.workspaces.workspaceEntitlements(workspaceId)) ?? []),
    };
  }
  private async lock(tx: WorkspaceTxClient, workspaceId: string, quoteId: string) {
    await tx.$queryRaw`SELECT id FROM quotes WHERE id=${quoteId} AND workspace_id=${workspaceId} FOR UPDATE`;
    const q = await tx.quote.findFirst({
      where: { id: quoteId, workspaceId },
      select: {
        id: true,
        workspaceId: true,
        customerId: true,
        status: true,
        validUntil: true,
        currentVersionNo: true,
        lockedForSend: true,
        sendPendingApproval: true,
        customer: { select: { contactId: true } },
        recipients: { select: { role: true, email: true } },
      },
    });
    if (!q) throw new NotFoundException('Quote not found');
    return q;
  }
  private async event(
    tx: WorkspaceTxClient,
    ws: string,
    quoteId: string,
    kind: string,
    data: any = {},
    versionId?: string,
    actor = 'system:quotes',
    meta?: RequestMeta,
  ) {
    await this.audit.logInTransaction(tx, {
      workspaceId: ws,
      userId: actor,
      action: 'UPDATE',
      resource: 'quote',
      resourceId: quoteId,
      details: { kind, versionId: versionId ?? null },
      ipAddress: meta?.ip ?? undefined,
      userAgent: meta?.ua ?? undefined,
    });
    return tx.quoteEvent.create({
      data: { workspaceId: ws, quoteId, versionId, kind, actor, data, ip: meta?.ip, ua: meta?.ua },
    });
  }
  async send(user: User, ws: string | undefined, quoteId: string, key: string) {
    const workspace = await this.authorized(user, ws);
    if (!key || key.length > 200) throw new BadRequestException('Idempotency-Key is required');
    const sendKeyHash = sha256('send\0' + key),
      ctx = await this.context(workspace, user);
    await this.workspaces.assertAgentsNotPaused(workspace);
    if (!this.email.isConfigured() || !this.email.checkEntitlement(ctx).allowed)
      throw new ServiceUnavailableException('Email-Ops is unavailable or not entitled');
    const brief = await this.db.withWorkspace(workspace, ucUidOf(user), (tx) =>
      tx.quote.findFirst({
        where: { workspaceId: workspace, id: quoteId },
        select: { customer: { select: { contactId: true } } },
      }),
    );
    if (!brief) throw new NotFoundException('Quote not found');
    const presentation = await this.presentation.forSend(workspace, brief.customer.contactId);
    const base = this.config.get<string>('QUOTES_PUBLIC_BASE_URL')?.replace(/\/$/, '');
    if (!base || !/^https:\/\//.test(base))
      throw new ServiceUnavailableException('QUOTES_PUBLIC_BASE_URL must be HTTPS');
    const capability = newShareToken();
    const prep = await this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
      const q = await this.lock(tx, workspace, quoteId);
      const prior = await tx.quoteVersion.findFirst({
        where: { workspaceId: workspace, quoteId, sendKeyHash },
      });
      if (prior) return { replay: true as const, version: prior };
      if (q.status !== 'draft' || q.lockedForSend)
        throw new ConflictException('Only an unlocked draft can be sent');
      if (q.validUntil <= new Date()) throw new BadRequestException('Quote validity has expired');
      const recipient = q.recipients.find((r) => r.role === 'to');
      if (!recipient) throw new BadRequestException('Set a To recipient before sending');
      const prepared = await prepareQuoteSnapshot(tx, workspace, quoteId, presentation);
      await tx.quoteVersion.updateMany({
        where: { workspaceId: workspace, quoteId, disposition: 'current' },
        data: { disposition: 'superseded' },
      });
      const version = await tx.quoteVersion.create({
        data: {
          workspaceId: workspace,
          quoteId,
          versionNo: q.currentVersionNo + 1,
          snapshot: prepared.snapshot as any,
          renderHash: prepared.renderHash,
          sendKeyHash,
        },
      });
      await tx.quoteShareToken.create({
        data: {
          workspaceId: workspace,
          quoteId,
          versionId: version.id,
          tokenHash: capability.tokenHash,
          expiresAt: q.validUntil,
        },
      });
      await tx.quote.update({
        where: { id: quoteId },
        data: {
          currentVersionNo: version.versionNo,
          lockedForSend: true,
          sendPendingApproval: true,
        },
      });
      await this.event(
        tx,
        workspace,
        quoteId,
        'send_pending_approval',
        {},
        version.id,
        ucUidOf(user),
      );
      return {
        replay: false as const,
        version,
        to: recipient.email,
        contactId: q.customer.contactId,
      };
    });
    if (prep.replay) return { versionId: prep.version.id, status: prep.version.approvalState };
    const ref = 'quote-send:' + prep.version.id;
    let result;
    try {
      const fromAddress = this.config.get<string>('QUOTE_FROM_ADDRESS')?.trim();
      result = await this.email.composeEmail(ctx, {
        contactId: prep.contactId!,
        toAddress: prep.to!,
        ...(fromAddress ? { fromAddress } : {}),
        subject: 'Your proposal',
        body: `Please review your proposal: ${base}/${capability.token}`,
        mode: 'draft',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
    } catch {
      result = null;
    }
    if (
      !result ||
      result.mode !== 'draft' ||
      !['draft', 'pending_approval'].includes(result.status) ||
      result.externalRef !== ref
    ) {
      await this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
        const currentQuote = await this.lock(tx, workspace, quoteId);
        await tx.quoteShareToken.updateMany({
          where: { versionId: prep.version.id },
          data: { revokedAt: new Date() },
        });
        await tx.quoteVersion.update({
          where: { id: prep.version.id },
          data: { approvalState: 'compose_failed' },
        });
        if (currentQuote.currentVersionNo === prep.version.versionNo)
          await tx.quote.update({
            where: { id: quoteId },
            data: { lockedForSend: false, sendPendingApproval: false },
          });
        await this.event(
          tx,
          workspace,
          quoteId,
          'error',
          { code: 'DRAFT_COMPOSE_UNCONFIRMED' },
          prep.version.id,
        );
      });
      throw new ServiceUnavailableException(
        'Draft composition was not confirmed; the link is revoked',
      );
    }
    await this.db.withWorkspace(workspace, ucUidOf(user), (tx) =>
      tx.quoteVersion.update({
        where: { id: prep.version.id },
        data: { emailOpsMessageId: result.id },
      }),
    );
    const item = await this.email.findAgentInboxItem(ctx, result.id).catch(() => null);
    if (item && item.messageId === result.id)
      await this.db.withWorkspace(workspace, ucUidOf(user), (tx) =>
        tx.quoteVersion.update({
          where: { id: prep.version.id },
          data: { emailOpsItemId: item.id },
        }),
      );
    return { versionId: prep.version.id, status: 'pending', emailOpsItemId: item?.id ?? null };
  }
  async observe(workspace: string, versionId: string) {
    const version = await this.db.withWorkspace(workspace, null, (tx) =>
      tx.quoteVersion.findFirst({ where: { workspaceId: workspace, id: versionId } }),
    );
    if (!version || version.approvalState !== 'pending' || !version.emailOpsMessageId) return;
    const ctx = await this.context(workspace);
    const item = await (
      version.emailOpsItemId
        ? this.email.getAgentInboxItem(ctx, version.emailOpsItemId)
        : this.email.findAgentInboxItem(ctx, version.emailOpsMessageId)
    ).catch(() => null);
    if (!item || item.messageId !== version.emailOpsMessageId || item.status === 'pending') return;
    await this.db.withWorkspace(
      workspace,
      null,
      async (tx) => {
        const q = await this.lock(tx, workspace, version.quoteId);
        const current = await tx.quoteVersion.findUnique({ where: { id: versionId } });
        if (
          !current ||
          current.approvalState !== 'pending' ||
          current.versionNo !== q.currentVersionNo ||
          !q.sendPendingApproval
        )
          return;
        const now = new Date();
        if (item.status === 'rejected') {
          await tx.quoteShareToken.updateMany({
            where: { versionId, revokedAt: null },
            data: { revokedAt: now },
          });
          await tx.quoteVersion.update({
            where: { id: versionId },
            data: { approvalState: 'rejected', emailOpsItemId: item.id },
          });
          await tx.quote.update({
            where: { id: q.id },
            data: { status: 'draft', lockedForSend: false, sendPendingApproval: false },
          });
          await this.event(tx, workspace, q.id, 'send_rejected', {}, versionId);
        } else if (['approved', 'sent'].includes(item.status)) {
          if (q.validUntil <= now) return;
          await tx.quoteVersion.update({
            where: { id: versionId },
            data: { approvalState: 'approved', emailOpsItemId: item.id },
          });
          await tx.quoteShareToken.updateMany({
            where: { versionId, revokedAt: null, activatedAt: null },
            data: { activatedAt: now },
          });
          await tx.quote.update({
            where: { id: q.id },
            data: { status: 'sent', sentAt: now, lockedForSend: false, sendPendingApproval: false },
          });
          await tx.customer.updateMany({
            where: { id: q.customerId, workspaceId: workspace, stage: 'LEAD' },
            data: { stage: 'PROSPECT' },
          });
          await this.event(tx, workspace, q.id, 'send_approved', {}, versionId);
          await this.event(tx, workspace, q.id, 'sent', {}, versionId);
          if (current.versionNo > 1)
            await this.event(
              tx,
              workspace,
              q.id,
              'quote.superseded',
              {
                quote_ref: q.id,
                prior_version: current.versionNo - 1,
                new_version: current.versionNo,
              },
              versionId,
            );
        }
      },
      // Bookkeeping, not a user write: it records a send Email-Ops already made,
      // and runs from the public quote page, a read a suspended workspace still serves.
      { allowWhenWriteLocked: true },
    );
  }
  private async tokenScope(token: string) {
    this.enabled();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const rows = await this.db.$queryRaw<
      Array<{ workspace: string | null }>
    >`SELECT public.quote_token_workspace(${sha256(token)}) AS workspace`;
    return rows[0]?.workspace ?? null;
  }
  private async tokenRows(tx: WorkspaceTxClient, workspace: string, token: string) {
    const row = await tx.quoteShareToken.findFirst({
      where: { workspaceId: workspace, tokenHash: sha256(token) },
      include: { version: true },
    });
    if (!row) return null;
    const q = await this.lock(tx, workspace, row.quoteId);
    // Re-read after acquiring the parent lock: revocation/activation cannot race acceptance.
    const fresh = await tx.quoteShareToken.findUnique({
      where: { id: row.id },
      include: { version: true },
    });
    return fresh ? { token: fresh, q, version: fresh.version } : null;
  }
  private postFailure(rows: NonNullable<Awaited<ReturnType<QuotesLifecycleService['tokenRows']>>>) {
    const { token, version, q } = rows;
    if (version.disposition === 'superseded' || version.versionNo !== q.currentVersionNo)
      return failure(409, 'QUOTE_SUPERSEDED', 'Ask for the current quote.');
    if (
      token.revokedAt ||
      token.expiresAt <= new Date() ||
      ['expired', 'voided'].includes(q.status)
    )
      return failure(410, 'QUOTE_EXPIRED', 'This quote link is no longer available.');
    if (!token.activatedAt)
      return failure(503, 'QUOTE_NOT_AVAILABLE', 'This quote is not available yet.');
    return null;
  }
  async lookup(token: string, meta: RequestMeta): Promise<PublicLookup> {
    const workspace = await this.tokenScope(token);
    if (!workspace) return { found: false };
    const initial = await this.db.withWorkspace(workspace, null, (tx) =>
      tx.quoteShareToken.findFirst({
        where: { tokenHash: sha256(token) },
        select: { versionId: true, activatedAt: true, revokedAt: true },
      }),
    );
    if (initial && !initial.activatedAt && !initial.revokedAt)
      await this.observe(workspace, initial.versionId);
    const resolved = await this.db.withWorkspace(
      workspace,
      null,
      async (tx) => {
        const r = await this.tokenRows(tx, workspace, token);
        if (!r) return null;
        if (!r.token.activatedAt && !r.token.revokedAt) {
          await this.event(
            tx,
            workspace,
            r.q.id,
            'view_unavailable',
            {},
            r.version.id,
            'public',
            meta,
          );
          return { unavailable: true as const };
        }
        if (!r.token.activatedAt) return null;
        const state =
          r.version.disposition === 'superseded'
            ? 'superseded'
            : r.token.revokedAt
              ? 'revoked'
              : r.token.expiresAt <= new Date()
                ? 'expired'
                : r.q.status === 'voided'
                  ? 'voided'
                  : r.version.acceptedAt
                    ? 'accepted'
                    : 'open';
        await tx.quoteShareToken.update({
          where: { id: r.token.id },
          data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
        });
        if (state === 'open' && r.q.status === 'sent')
          await tx.quote.update({ where: { id: r.q.id }, data: { status: 'viewed' } });
        await this.event(tx, workspace, r.q.id, 'viewed', {}, r.version.id, 'public', meta);
        return {
          unavailable: false as const,
          snapshot: (r.version.acceptedSnapshot ?? r.version.snapshot) as unknown as QuoteSnapshot,
          state,
          version: r.version,
          recipients: r.q.recipients.length > 0,
        };
      },
      // Bookkeeping of a read (view counter, `viewed` status and event): the
      // public quote page keeps working while the workspace is suspended or archived.
      { allowWhenWriteLocked: true },
    );
    if (!resolved) return { found: false };
    if (resolved.unavailable) throw new QuoteNotAvailable();
    const vendor = await this.presentation.letterhead(workspace);
    const snapshot = { ...resolved.snapshot, letterhead: vendor.letterhead };
    const view = toPublishedQuoteView(snapshot, {
      state: resolved.state as any,
      version: { no: resolved.version.versionNo, disposition: resolved.version.disposition as any },
      issued_on: resolved.version.createdAt.toISOString(),
      accepted_by: resolved.version.acceptedBy as any,
      state_at: resolved.version.acceptedAt?.toISOString(),
      recipients_gate: resolved.recipients,
    });
    return { found: true, view, token_prefix: 'public' };
  }
  private selected(snapshot: QuoteSnapshot, ids: string[]) {
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !snapshot.lines.some((l) => l.id === id && l.option_group))
    )
      throw new BadRequestException('Invalid selected options');
    const lines = snapshot.lines.map((l) =>
      l.option_group ? { ...l, selected: ids.includes(l.id) } : l,
    );
    const totals = computeQuote({
      currency: snapshot.currency,
      lines,
      option_groups: snapshot.option_groups,
      tax_estimate_cents: snapshot.tax_estimate_cents,
    });
    if (
      totals.line_errors.length ||
      totals.option_group_errors.length ||
      totals.lines.some((l) => l.payment_parts.some((p) => p < 0))
    )
      throw new BadRequestException('Invalid quote selection or payment schedule');
    return { ...snapshot, lines, totals };
  }
  async begin(token: string, payload: AcceptPayload, meta: RequestMeta): Promise<AcceptOutcome> {
    const workspace = await this.tokenScope(token);
    if (!workspace) return failure(404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
    let key: string;
    try {
      key = idempotencyHash(meta.idempotency_key ?? undefined, 'begin');
    } catch {
      return failure(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const email = payload.email.trim().toLowerCase();
    if (!payload.accepted || !z.string().email().safeParse(email).success)
      return failure(400, 'ACCEPT_BODY', 'Acceptance and a valid email are required.');
    const secret = this.config.get<string>('QUOTES_ACCEPTANCE_SECRET') || '';
    const code = newAcceptanceCode(),
      pendingId = randomUUID();
    let codeHash: string;
    try {
      codeHash = acceptanceCodeHash(secret, pendingId, code);
    } catch {
      return failure(503, 'CODE_UNAVAILABLE', 'Verification is unavailable.');
    }
    const ctx = await this.context(workspace);
    if (!this.email.isConfigured() || !this.email.checkEntitlement(ctx).allowed)
      return failure(503, 'CODE_UNAVAILABLE', 'Verification email is unavailable.');
    await this.workspaces.assertAgentsNotPaused(workspace);
    const requestHash = sha256(canonicalJson({ ...payload, email }));
    const prepared = await this.db.withWorkspace(workspace, null, async (tx) => {
      const r = await this.tokenRows(tx, workspace, token);
      if (!r) return { error: failure(404, 'QUOTE_NOT_FOUND', 'No quote at this link.') };
      const error = this.postFailure(r);
      if (error) return { error };
      if (r.version.acceptedAt)
        return { error: failure(409, 'QUOTE_ACCEPTED', 'This quote is already accepted.') };
      const prior = await tx.quotePendingAcceptance.findFirst({
        where: { workspaceId: workspace, tokenId: r.token.id, beginKeyHash: key },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          return {
            error: failure(
              409,
              'IDEMPOTENCY_CONFLICT',
              'The key was used for a different request.',
            ),
          };
        if (prior.voidedAt || prior.expiresAt <= new Date())
          return { error: failure(410, 'PENDING_EXPIRED', 'Request a new verification code.') };
        if (prior.deliveryState !== 'sent')
          return {
            error: failure(
              503,
              'CODE_UNAVAILABLE',
              'Verification delivery was not confirmed; use a new request key.',
            ),
          };
        return { pending: prior, replay: true, contactId: r.q.customer.contactId };
      }
      if (r.q.recipients.length && !r.q.recipients.some((p) => p.email.toLowerCase() === email))
        return { error: failure(403, 'RECIPIENT_REQUIRED', 'Use an invited recipient address.') };
      try {
        this.selected(r.version.snapshot as any, payload.selected_line_ids);
      } catch {
        return {
          error: failure(400, 'OPTIONS_INVALID', 'Select one option in each required group.'),
        };
      }
      if (
        (await tx.quotePendingAcceptance.count({
          where: { tokenId: r.token.id, expiresAt: { gt: new Date() } },
        })) >= 20
      )
        return { error: failure(429, 'CODE_LIMIT', 'Too many pending verification attempts.') };
      const now = new Date();
      const pending = await tx.quotePendingAcceptance.create({
        data: {
          id: pendingId,
          workspaceId: workspace,
          quoteId: r.q.id,
          versionId: r.version.id,
          tokenId: r.token.id,
          name: payload.name.slice(0, 200),
          email,
          title: payload.title?.slice(0, 200),
          selectedLineIds: payload.selected_line_ids,
          codeHash,
          beginKeyHash: key,
          requestHash,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 600000),
          ip: meta.ip,
          ua: meta.ua,
        },
      });
      await this.event(
        tx,
        workspace,
        r.q.id,
        'acceptance_pending',
        { pending_id: pending.id },
        r.version.id,
        'public',
        meta,
      );
      return { pending, replay: false, contactId: r.q.customer.contactId };
    });
    if (prepared.error) return prepared.error;
    const pending = prepared.pending!;
    if (!prepared.replay) {
      let result;
      try {
        result = await this.email.composeEmail(ctx, {
          contactId: prepared.contactId!,
          toAddress: email,
          subject: 'Your quote verification code',
          body: `Your verification code is ${code}. It expires in ten minutes.`,
          mode: 'send',
          externalSource: 'customer-ops',
          externalRef: 'quote-code:' + pending.id,
        });
      } catch {
        result = null;
      }
      const delivered =
        result?.externalRef === 'quote-code:' + pending.id &&
        result?.mode === 'send' &&
        ['queued', 'sent', 'delivered'].includes(result.status);
      await this.db.withWorkspace(workspace, null, (tx) =>
        tx.quotePendingAcceptance.update({
          where: { id: pending.id },
          data: {
            deliveryState: delivered ? 'sent' : 'failed',
            ...(!delivered ? { voidedAt: new Date() } : {}),
          },
        }),
      );
      if (!delivered)
        return failure(503, 'CODE_UNAVAILABLE', 'Verification delivery was not confirmed.');
    }
    return {
      ok: true,
      status: 202,
      pending_id: pending.id,
      expires_at: pending.expiresAt.toISOString(),
      email_hint: email.slice(0, 1) + '***@' + email.split('@')[1],
    };
  }
  async confirm(
    token: string,
    payload: ConfirmPayload,
    meta: RequestMeta,
  ): Promise<ConfirmOutcome> {
    const workspace = await this.tokenScope(token);
    if (!workspace) return failure(404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
    if (!payload.pending_id) return failure(400, 'PENDING_REQUIRED', 'pending_id is required.');
    let key: string;
    try {
      key = idempotencyHash(meta.idempotency_key ?? undefined, 'confirm');
    } catch {
      return failure(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.');
    }
    const secret = this.config.get<string>('QUOTES_ACCEPTANCE_SECRET') || '';
    if (Buffer.byteLength(secret) < 32)
      return failure(503, 'CODE_UNAVAILABLE', 'Verification is unavailable.');
    return this.db.withWorkspace(workspace, null, async (tx) => {
      const r = await this.tokenRows(tx, workspace, token);
      if (!r) return failure(404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
      const error = this.postFailure(r);
      if (error) return error;
      const pending = await tx.quotePendingAcceptance.findFirst({
        where: { id: payload.pending_id!, tokenId: r.token.id, workspaceId: workspace },
      });
      if (!pending) return failure(404, 'PENDING_NOT_FOUND', 'Pending acceptance not found.');
      if (!/^\d{6}$/.test(payload.code))
        return failure(400, 'CODE_INVALID', 'Enter the six-digit code.');
      // A plain hash here would expose the low-entropy code to an offline search.
      const fingerprint = acceptanceCodeHash(secret, pending.id, payload.code);
      const receipts = (pending.confirmReceipts ?? []) as any[];
      const replay = receipts.find((receipt) => receipt.key === key);
      if (replay)
        return replay.fingerprint === fingerprint
          ? replay.outcome
          : failure(409, 'IDEMPOTENCY_CONFLICT', 'The key was used for a different request.');
      if (pending.confirmedAt) {
        if (
          pending.confirmKeyHash !== key ||
          !acceptanceCodeMatches(secret, pending.id, payload.code, pending.codeHash)
        )
          return failure(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Confirmation does not match the committed request.',
          );
        return { ok: true, status: 200, accepted_at: pending.confirmedAt.toISOString() };
      }
      if (r.version.acceptedAt)
        return failure(409, 'QUOTE_ACCEPTED', 'This quote is already accepted.');
      if (pending.voidedAt || pending.expiresAt <= new Date() || pending.attempts >= 5)
        return failure(410, 'PENDING_EXPIRED', 'Request a new verification code.');
      if (pending.deliveryState !== 'sent')
        return failure(503, 'CODE_UNAVAILABLE', 'Verification delivery is not confirmed.');
      if (
        r.q.recipients.length &&
        !r.q.recipients.some((p) => p.email.toLowerCase() === pending.email)
      )
        return failure(403, 'RECIPIENT_REQUIRED', 'Recipient is no longer authorized.');
      if (!acceptanceCodeMatches(secret, pending.id, payload.code, pending.codeHash)) {
        const attempts = pending.attempts + 1;
        const outcome = {
          ...failure(
            attempts === 5 ? 410 : 400,
            attempts === 5 ? 'PENDING_VOIDED' : 'CODE_INVALID',
            'Verification code is invalid.',
          ),
          attempts_left: 5 - attempts,
        };
        await tx.quotePendingAcceptance.update({
          where: { id: pending.id },
          data: {
            attempts,
            confirmReceipts: [...receipts, { key, fingerprint, outcome }],
            ...(attempts === 5 ? { voidedAt: new Date() } : {}),
          },
        });
        await this.event(
          tx,
          workspace,
          r.q.id,
          'acceptance_code_failed',
          { pending_id: pending.id, attempts },
          r.version.id,
          'public',
          meta,
        );
        return outcome;
      }
      const acceptedSnapshot = this.selected(
          r.version.snapshot as any,
          pending.selectedLineIds as string[],
        ),
        now = new Date();
      const acceptedBy = {
        name: pending.name,
        email: pending.email,
        title: pending.title,
        ip: meta.ip,
        ua: meta.ua,
      };
      await tx.quoteVersion.update({
        where: { id: r.version.id },
        data: {
          acceptedSnapshot: acceptedSnapshot as any,
          acceptedAt: now,
          acceptedBy,
          disposition: 'accepted',
        },
      });
      await tx.quote.update({
        where: { id: r.q.id },
        data: { status: 'accepted', acceptedAt: now, acceptedBy },
      });
      for (const line of acceptedSnapshot.lines.filter((l) => l.option_group))
        await tx.quoteLine.updateMany({
          where: { id: line.id, quoteId: r.q.id, workspaceId: workspace },
          data: { selected: line.selected },
        });
      await tx.quotePendingAcceptance.update({
        where: { id: pending.id },
        data: {
          confirmedAt: now,
          confirmKeyHash: key,
          confirmReceipts: [
            ...receipts,
            {
              key,
              fingerprint,
              outcome: { ok: true, status: 200, accepted_at: now.toISOString() },
            },
          ],
        },
      });
      await tx.customer.updateMany({
        where: { id: r.q.customerId, workspaceId: workspace },
        data: { stage: 'CUSTOMER' },
      });
      await this.event(
        tx,
        workspace,
        r.q.id,
        'accepted',
        { version_no: r.version.versionNo },
        r.version.id,
        'public',
        meta,
      );
      await this.event(
        tx,
        workspace,
        r.q.id,
        'quote.accepted',
        { quote_ref: r.q.id, version: r.version.versionNo },
        r.version.id,
      );
      return { ok: true, status: 200, accepted_at: now.toISOString() };
    });
  }
  async recordAcceptance(
    user: User,
    ws: string | undefined,
    quoteId: string,
    input: unknown,
    key: string,
  ) {
    const workspace = await this.authorized(user, ws);
    if ((await this.membership.roleInWorkspace(user, workspace)) !== WorkspaceRole.OWNER)
      throw new ForbiddenException('Workspace owner required');
    const schema = z
      .object({
        name: z.string().trim().min(1).max(200),
        email: z.string().email(),
        title: z.string().max(200).nullable().optional(),
        when: z.string().datetime(),
        how: z.string().trim().min(1).max(500),
        selected_line_ids: z.array(z.string()).max(200),
      })
      .strict();
    const validation = schema.safeParse(input);
    if (!validation.success) throw new BadRequestException('Invalid owner-recorded acceptance');
    const parsed = validation.data;
    if (!key?.trim() || key.length > 200)
      throw new BadRequestException('Idempotency-Key is required');
    const fingerprint = sha256(canonicalJson(parsed)),
      keyHash = sha256('record\0' + key);
    const recorded = await this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
      const q = await this.lock(tx, workspace, quoteId);
      const prior = await tx.quoteEvent.findFirst({
        where: {
          quoteId,
          kind: 'owner_recorded_acceptance',
          data: { path: ['key_hash'], equals: keyHash },
        },
      });
      if (prior) {
        if ((prior.data as any).fingerprint !== fingerprint)
          throw new ConflictException('Idempotency key conflict');
        return { accepted_at: (prior.data as any).accepted_at };
      }
      if (!['sent', 'viewed'].includes(q.status) || q.lockedForSend || q.validUntil <= new Date())
        throw new ConflictException('Only a current available quote can be accepted');
      const version = await tx.quoteVersion.findFirst({
        where: {
          quoteId,
          workspaceId: workspace,
          versionNo: q.currentVersionNo,
          approvalState: 'approved',
          disposition: 'current',
        },
      });
      if (!version) throw new ConflictException('No approved version');
      if (new Date(parsed.when) > new Date())
        throw new BadRequestException('Acceptance cannot be in the future');
      const acceptedSnapshot = this.selected(version.snapshot as any, parsed.selected_line_ids),
        now = new Date(parsed.when);
      const acceptedBy = {
        name: parsed.name,
        email: parsed.email,
        title: parsed.title ?? null,
        recorded_by_member: ucUidOf(user),
        how: parsed.how,
      };
      await tx.quoteVersion.update({
        where: { id: version.id },
        data: {
          acceptedSnapshot: acceptedSnapshot as any,
          acceptedAt: now,
          acceptedBy,
          disposition: 'accepted',
        },
      });
      await tx.quote.update({
        where: { id: quoteId },
        data: { status: 'accepted', acceptedAt: now, acceptedBy },
      });
      for (const line of acceptedSnapshot.lines.filter((l) => l.option_group))
        await tx.quoteLine.updateMany({
          where: { id: line.id, quoteId, workspaceId: workspace },
          data: { selected: line.selected },
        });
      await tx.customer.updateMany({
        where: { id: q.customerId, workspaceId: workspace },
        data: { stage: 'CUSTOMER' },
      });
      await this.event(
        tx,
        workspace,
        quoteId,
        'owner_recorded_acceptance',
        { key_hash: keyHash, fingerprint, accepted_at: now.toISOString(), how: parsed.how },
        version.id,
        ucUidOf(user),
      );
      await this.event(
        tx,
        workspace,
        quoteId,
        'accepted',
        { owner_recorded: true },
        version.id,
        ucUidOf(user),
      );
      await this.event(
        tx,
        workspace,
        quoteId,
        'quote.accepted',
        { quote_ref: quoteId, version: version.versionNo },
        version.id,
      );
      return { accepted_at: now.toISOString() };
    });
    const federated = await this.federateAcceptedQuote(user, workspace, quoteId);
    return { ...recorded, federated };
  }
  /**
   * Fan an accepted quote out to Accounting-Ops (the invoice drafts) and
   * Project-Ops (the project). Each side is attempted on its own: one side
   * failing never stops the other. A side is 'ok' only when its callee confirmed
   * it. The status is always written back to quotes.federated; a side that ends
   * 'failed' is re-run by reconcile() (`retry` names the sides to re-run and the
   * prior status to keep for the rest). Both callees are idempotent on replay,
   * which is what makes the retry safe:
   * - Accounting-Ops create_invoices_from_quote: its schedules are unique on
   *   (workspace_id, quote_ref, line_position) with ON CONFLICT DO NOTHING
   *   (accounting-ops app/ar/quotes_seam.py), so a replay adds no second invoice.
   * - Project-Ops POST /api/v1/federation/quotes/accepted: idempotent by
   *   (workspace, customer_ops_quote_id, version) with a pg advisory-lock
   *   re-check inside the write tx (project-ops
   *   backend/src/quotes/quotes-federation.service.ts); a replay returns the
   *   same ids, never a second project.
   */
  private async federateAcceptedQuote(
    user: User | null,
    workspace: string,
    quoteId: string,
    retry?: FederationRetry,
  ) {
    const actor = user ? ucUidOf(user) : null;
    const federated: FederatedStatus = {
      accounting_ops: 'skipped',
      project_ops: 'skipped',
      ...(retry?.prior ?? {}),
    };
    const run = {
      accounting_ops: !retry || retry.accounting_ops,
      project_ops: !retry || retry.project_ops,
    };
    if (retry) federated.retries = (Number(retry.prior.retries) || 0) + 1;
    delete federated.next_retry_at;
    const sideFailed = (side: 'accounting_ops' | 'project_ops', err: unknown) => {
      federated[side] = 'failed';
      this.logger.warn(
        `Quote ${quoteId} ${side} fan-out failed (reconcile will retry): ${(err as Error)?.message ?? err}`,
      );
    };
    try {
      const bundle = await this.db.withWorkspace(workspace, actor, (tx) =>
        tx.quote.findFirst({
          where: { id: quoteId, workspaceId: workspace },
          select: {
            id: true,
            number: true,
            title: true,
            currency: true,
            customerId: true,
            versions: {
              where: { disposition: 'accepted' },
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { versionNo: true, snapshot: true, acceptedSnapshot: true },
            },
          },
        }),
      );
      const version = bundle?.versions?.[0];
      const snap = (version?.acceptedSnapshot ?? version?.snapshot) as
        | {
            customer?: { display_name?: string; org_name?: string | null };
            lines?: Array<Record<string, any>>;
            totals?: Record<string, any>;
          }
        | null
        | undefined;
      const lines = (snap?.lines ?? []).filter(
        (line) => line && line.selected !== false && line.label && line.kind,
      );
      if (bundle && version && run.accounting_ops && this.accounting?.isConfigured()) {
        const entityId = this.config.get<string>('ACCOUNTING_OPS_ENTITY_ID')?.trim();
        const aoLines = lines
          .filter((line) => typeof line.amount_cents === 'number')
          .map((line, index) => ({
            kind: line.kind,
            label: String(line.label).slice(0, 512),
            amount_cents: Math.round(line.amount_cents),
            position: typeof line.position === 'number' ? line.position : index,
            ...(line.id ? { line_id: String(line.id) } : {}),
            ...(line.kind === 'recurring' && line.recurring?.interval
              ? { recurring: { interval: line.recurring.interval } }
              : {}),
          }));
        if (!entityId || aoLines.length === 0) {
          federated.accounting_ops = 'skipped';
        } else {
          try {
            const ctx = await this.context(workspace, user ?? undefined);
            if (!this.accounting.checkEntitlement(ctx).allowed) {
              if (retry && (ctx.entitlements ?? []).length === 0) {
                // CUO76-R2-2: the retry has no user, so its entitlements come
                // from the workspace cache alone. A missing or empty cache is
                // UNKNOWN, not a revocation: keep the side 'failed' so a later
                // reconcile retries it, and say so loudly.
                federated.accounting_ops = 'failed';
                this.logger.error(
                  `Quote ${quoteId} accounting_ops retry: workspace ${workspace} entitlements ` +
                    'are unknown (no entitlement cache); left failed, reconcile will retry',
                );
              } else {
                // The entitlements are known and lack Accounting-Ops: revoked.
                federated.accounting_ops = 'skipped';
                this.logger.warn(
                  `Quote ${quoteId} accounting_ops fan-out skipped: workspace ${workspace} ` +
                    'is not entitled to Accounting-Ops',
                );
              }
            } else {
              const totals = snap?.totals;
              federated.accounting_ops = await this.accounting.acceptQuote(ctx, {
                entityId,
                quoteRef: bundle.number,
                version: version.versionNo,
                currency: bundle.currency || 'USD',
                customer: {
                  display_name: snap?.customer?.display_name || bundle.title,
                  ...(snap?.customer?.org_name ? { org: snap.customer.org_name } : {}),
                },
                lines: aoLines,
                totals: totals
                  ? {
                      one_time_total_cents: totals.one_time_cents ?? 0,
                      milestone_total_cents: totals.milestone_cents ?? 0,
                      deposit_cents: totals.deposit_cents ?? 0,
                      recurring: {
                        ...(totals.recurring?.month_cents
                          ? { month: totals.recurring.month_cents }
                          : {}),
                        ...(totals.recurring?.quarter_cents
                          ? { quarter: totals.recurring.quarter_cents }
                          : {}),
                        ...(totals.recurring?.year_cents
                          ? { year: totals.recurring.year_cents }
                          : {}),
                      },
                    }
                  : null,
              });
              if (federated.accounting_ops === 'failed')
                sideFailed('accounting_ops', new Error('Accounting-Ops did not confirm'));
            }
          } catch (err) {
            sideFailed('accounting_ops', err);
          }
        }
      }
      const base = this.config.get<string>('QUOTES_PUBLIC_BASE_URL')?.replace(/\/$/, '');
      if (
        bundle &&
        version &&
        run.project_ops &&
        this.projects?.isConfigured() &&
        base &&
        /^https:\/\//.test(base) &&
        lines.length > 0
      ) {
        const totals = snap?.totals ?? {};
        const recurring = [
          totals.recurring?.month_cents
            ? { interval: 'month', amount_cents: totals.recurring.month_cents }
            : null,
          totals.recurring?.quarter_cents
            ? { interval: 'quarter', amount_cents: totals.recurring.quarter_cents }
            : null,
          totals.recurring?.year_cents
            ? { interval: 'year', amount_cents: totals.recurring.year_cents }
            : null,
        ].filter((row) => row !== null);
        try {
          const ctx = await this.context(workspace, user ?? undefined);
          federated.project_ops = await this.projects.acceptQuote(ctx, {
            customer_ops_quote_id: quoteId,
            number: bundle.number,
            version: version.versionNo,
            title: bundle.title,
            share_url: base,
            client_name: snap?.customer?.display_name || bundle.title,
            customer_ops_customer_id: bundle.customerId,
            currency: (bundle.currency || 'USD').slice(0, 3),
            billing: {
              one_time_total_cents: totals.one_time_cents ?? 0,
              milestone_total_cents: totals.milestone_cents ?? 0,
              deposit_cents: totals.deposit_cents ?? 0,
              schedule_text: `Accepted ${bundle.number}.`,
              ...(recurring.length > 0 ? { recurring } : {}),
            },
            lines: lines.map((line, index) => ({
              kind: line.kind,
              label: String(line.label).slice(0, 500),
              position: typeof line.position === 'number' ? line.position : index,
              ...(typeof line.amount_cents === 'number'
                ? { amount_cents: Math.round(line.amount_cents) }
                : {}),
              ...(line.id ? { customer_ops_line_id: String(line.id) } : {}),
            })),
          });
          if (federated.project_ops === 'failed')
            sideFailed('project_ops', new Error('Project-Ops did not confirm'));
        } catch (err) {
          sideFailed('project_ops', err);
        }
      }
    } catch (err) {
      // The quote could not be loaded, so neither side ran. A configured side
      // that is not yet 'ok' is marked failed so reconcile() retries it (the
      // retry re-evaluates and may settle on 'skipped').
      if (
        run.accounting_ops &&
        this.accounting?.isConfigured() &&
        federated.accounting_ops !== 'ok'
      )
        sideFailed('accounting_ops', err);
      if (run.project_ops && this.projects?.isConfigured() && federated.project_ops !== 'ok')
        sideFailed('project_ops', err);
    }
    if (
      (federated.accounting_ops === 'failed' || federated.project_ops === 'failed') &&
      (Number(federated.retries) || 0) >= FEDERATION_MAX_RETRIES
    )
      this.logger.error(
        `Quote ${quoteId} fan-out still failed after ${FEDERATION_MAX_RETRIES} retries; ` +
          'reconcile() will not retry it again: an operator must re-run the fan-out',
      );
    if (federated.accounting_ops === 'failed' || federated.project_ops === 'failed')
      federated.next_retry_at = new Date(
        Date.now() + federationBackoffMs(Number(federated.retries) || 0),
      ).toISOString();
    try {
      await this.db.withWorkspace(workspace, actor, (tx) =>
        tx.quote.update({
          where: { id: quoteId },
          data: { federated: federated as Prisma.InputJsonObject },
        }),
      );
    } catch (err) {
      // Acceptance is already committed; a failed status write does not undo it,
      // but without the write reconcile() cannot see a failed side. Say so.
      this.logger.error(
        `Quote ${quoteId} federated status write failed (status ${JSON.stringify(federated)}); ` +
          `a failed side will NOT be retried until the status is recorded: ${(err as Error)?.message ?? err}`,
      );
    }
    return federated;
  }
  async supersede(user: User, ws: string | undefined, quoteId: string) {
    const workspace = await this.authorized(user, ws);
    return this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
      const q = await this.lock(tx, workspace, quoteId);
      if (q.lockedForSend || q.status === 'draft' || q.status === 'voided')
        throw new ConflictException('Quote cannot be superseded in this state');
      await tx.quoteVersion.updateMany({
        where: { quoteId, workspaceId: workspace },
        data: { disposition: 'superseded' },
      });
      await tx.quote.update({
        where: { id: quoteId },
        data: { status: 'draft', acceptedAt: null, acceptedBy: Prisma.DbNull, sentAt: null },
      });
      await this.event(
        tx,
        workspace,
        quoteId,
        'superseded',
        { prior_version: q.currentVersionNo },
        undefined,
        ucUidOf(user),
      );
      return { status: 'draft' };
    });
  }
  async revoke(user: User, ws: string | undefined, quoteId: string, tokenId: string) {
    const workspace = await this.authorized(user, ws);
    return this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
      const q = await this.lock(tx, workspace, quoteId);
      const token = await tx.quoteShareToken.findFirst({
        where: { id: tokenId, quoteId, workspaceId: workspace },
        include: { version: { select: { versionNo: true } } },
      });
      if (!token) throw new NotFoundException('Token not found');
      if (!token.revokedAt)
        await tx.quoteShareToken.update({
          where: { id: tokenId },
          data: { revokedAt: new Date() },
        });
      if (!token.activatedAt) {
        await tx.quoteVersion.update({
          where: { id: token.versionId },
          data: { approvalState: 'rejected' },
        });
        if (q.sendPendingApproval && q.currentVersionNo === token.version.versionNo)
          await tx.quote.update({
            where: { id: quoteId },
            data: { sendPendingApproval: false, lockedForSend: false },
          });
      }
      await this.event(tx, workspace, quoteId, 'revoked', {}, token.versionId, ucUidOf(user));
      return { revoked: true };
    });
  }
  async preview(user: User, ws: string | undefined, quoteId: string) {
    const workspace = await this.authorized(user, ws, false);
    const vendor = await this.presentation.letterhead(workspace);
    return this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
      const q = await tx.quote.findFirst({
        where: { id: quoteId, workspaceId: workspace },
        select: { status: true, currentVersionNo: true },
      });
      if (!q) throw new NotFoundException('Quote not found');
      // A39: lock only establishes authority; the document comes from the public select-list.
      const persisted = await tx.quoteVersion.findFirst({
        where: { quoteId, workspaceId: workspace, versionNo: q.currentVersionNo },
      });
      const snapshot = persisted
        ? ((persisted.acceptedSnapshot ?? persisted.snapshot) as unknown as QuoteSnapshot)
        : (
            await prepareQuoteSnapshot(
              tx,
              workspace,
              quoteId,
              {
                customer: { display_name: 'Customer', org_name: null, attention: null },
                letterhead: vendor.letterhead,
              },
              false,
            )
          ).snapshot;
      return toPublishedQuoteView(
        { ...snapshot, letterhead: vendor.letterhead },
        {
          state: q.status === 'accepted' ? 'accepted' : q.status === 'draft' ? 'draft' : 'open',
          version: {
            no: q.currentVersionNo,
            disposition: (persisted?.disposition as any) ?? 'current',
          },
          accepted_by: persisted?.acceptedBy as any,
          state_at: persisted?.acceptedAt?.toISOString(),
        },
      );
    });
  }
  async letterheadSettings(user: User, ws: string, input?: unknown) {
    const workspace = await this.authorized(user, ws, input !== undefined);
    if (input !== undefined) {
      if (
        ![WorkspaceRole.OWNER, WorkspaceRole.ADMIN].includes(
          (await this.membership.roleInWorkspace(user, workspace)) as any,
        )
      )
        throw new ForbiddenException('Workspace admin required');
      const parsed = z
        .object({
          accountingEntityId: z.string().min(1).max(200),
          brandId: z.string().max(200).nullable().optional(),
          contactOrgId: z.string().max(200).nullable().optional(),
          quoteEmail: z.string().email().nullable().optional(),
          website: z.string().url().nullable().optional(),
          partnerDisplay: z.enum(['none', 'trading_name', 'legal_name']).optional(),
        })
        .strict()
        .safeParse(input);
      if (!parsed.success)
        throw new BadRequestException(
          'Only valid letterhead pointers and contact channels are accepted',
        );
      await this.db.withWorkspace(workspace, ucUidOf(user), (tx) =>
        tx.workspaceLetterhead.upsert({
          where: { workspaceId: workspace },
          create: { workspaceId: workspace, ...parsed.data },
          update: parsed.data,
        }),
      );
    }
    return this.presentation.letterhead(workspace);
  }
  async history(user: User, ws: string | undefined, quoteId: string, kind: 'versions' | 'events') {
    const workspace = await this.authorized(user, ws, false);
    return this.db.withWorkspace(workspace, ucUidOf(user), async (tx) => {
      if (
        !(await tx.quote.findFirst({
          where: { id: quoteId, workspaceId: workspace },
          select: { id: true },
        }))
      )
        throw new NotFoundException('Quote not found');
      if (kind === 'events')
        return tx.quoteEvent.findMany({
          where: { quoteId, workspaceId: workspace },
          orderBy: { at: 'desc' },
          take: 200,
        });
      return tx.quoteVersion.findMany({
        where: { quoteId, workspaceId: workspace },
        orderBy: { versionNo: 'desc' },
        take: 100,
        select: {
          id: true,
          versionNo: true,
          disposition: true,
          approvalState: true,
          emailOpsItemId: true,
          renderHash: true,
          pdfAssetRef: true,
          createdAt: true,
          acceptedAt: true,
          tokens: {
            select: {
              id: true,
              expiresAt: true,
              activatedAt: true,
              revokedAt: true,
              viewCount: true,
            },
          },
        },
      });
    });
  }
  async reconcile() {
    if (!quotesEnabled(this.config.get<string>('QUOTES_ENABLED'))) return;
    const workspaces = await this.db.workspace.findMany({ select: { id: true } });
    for (const ws of workspaces) {
      let after: string | undefined;
      do {
        const pending = await this.db.withWorkspace(ws.id, null, (tx) =>
          tx.quoteVersion.findMany({
            where: {
              approvalState: 'pending',
              quote: { sendPendingApproval: true },
              ...(after ? { id: { gt: after } } : {}),
            },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 100,
          }),
        );
        for (const version of pending) await this.observe(ws.id, version.id).catch(() => undefined);
        after = pending.length === 100 ? pending[pending.length - 1].id : undefined;
      } while (after);
      await this.retryFailedFederation(ws.id);
    }
  }
  /**
   * Re-run the accepted-quote fan-out for every side recorded 'failed' (CuO-SW-1).
   * Only failed sides are re-run; an 'ok' side is never called again, so a
   * confirmed invoice is not re-requested. Bounded by FEDERATION_MAX_RETRIES.
   */
  private async retryFailedFederation(workspace: string) {
    let after: string | undefined;
    do {
      const page = await this.db
        .withWorkspace(workspace, null, (tx) =>
          tx.quote.findMany({
            where: {
              workspaceId: workspace,
              status: 'accepted',
              OR: [
                { federated: { path: ['accounting_ops'], equals: 'failed' } },
                { federated: { path: ['project_ops'], equals: 'failed' } },
              ],
              ...(after ? { id: { gt: after } } : {}),
            },
            select: { id: true, federated: true },
            orderBy: { id: 'asc' },
            take: 100,
          }),
        )
        .catch((err) => {
          this.logger.warn(
            `Quote fan-out retry scan failed for ${workspace}: ${err?.message ?? err}`,
          );
          return [];
        });
      for (const row of page) {
        const prior = (row.federated ?? {}) as Record<string, unknown>;
        // Exhausted rows were logged once when they hit the cap.
        if ((Number(prior.retries) || 0) >= FEDERATION_MAX_RETRIES) continue;
        const due = Date.parse(String(prior.next_retry_at ?? ''));
        if (Number.isFinite(due) && due > Date.now()) continue;
        await this.federateAcceptedQuote(null, workspace, row.id, {
          accounting_ops: prior.accounting_ops === 'failed',
          project_ops: prior.project_ops === 'failed',
          prior,
        }).catch((err) =>
          this.logger.warn(`Quote ${row.id} fan-out retry failed: ${err?.message ?? err}`),
        );
      }
      after = page.length === 100 ? page[page.length - 1].id : undefined;
    } while (after);
  }
  async expire() {
    if (!quotesEnabled(this.config.get<string>('QUOTES_ENABLED'))) return;
    const workspaces = await this.db.workspace.findMany({ select: { id: true } });
    for (const ws of workspaces)
      await this.db.withWorkspace(ws.id, null, async (tx) => {
        const expired = await tx.quote.findMany({
          where: { validUntil: { lte: new Date() }, status: { in: ['draft', 'sent', 'viewed'] } },
          select: { id: true },
        });
        for (const row of expired) {
          const q = await this.lock(tx, ws.id, row.id);
          if (!['draft', 'sent', 'viewed'].includes(q.status) || q.validUntil > new Date())
            continue;
          await tx.quote.update({
            where: { id: q.id },
            data: { status: 'expired', lockedForSend: false, sendPendingApproval: false },
          });
          await this.event(tx, ws.id, q.id, 'expired');
        }
        await tx.quotePendingAcceptance.deleteMany({
          where: { expiresAt: { lt: new Date(Date.now() - 86400000) } },
        });
      });
  }
}
