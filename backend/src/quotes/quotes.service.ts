import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, User, WorkspaceRole } from '@prisma/client';
import { z } from 'zod';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf } from '../common/workspace/workspace.util';
import { computeStoredQuote, validateCurrency, QuoteComputationError } from './compute-quote';
import * as S from './quote.schemas';
import { AuditService } from '../audit/audit.service';
import { quoteSnapshotSelect } from './quote-snapshot';
import { quotesEnabled } from './quotes-enabled';
const include = {
  sections: { orderBy: { position: 'asc' as const } },
  lines: { orderBy: { position: 'asc' as const } },
  costs: true,
  recipients: true,
  attachments: true,
};
const writes = new Set([
  'create_quote',
  'update_quote',
  'add_quote_section',
  'add_quote_line',
  'update_quote_line',
  'remove_quote_line',
  'set_quote_options',
  'set_quote_recipients',
  'add_quote_cost',
  'add_quote_attachment',
]);
@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly workspaces: WorkspaceContextService,
    private readonly membership: MembershipService,
    private readonly audit: AuditService = new AuditService(workspaces),
  ) {}
  private enabled() {
    if (!quotesEnabled(this.config.get<string>('QUOTES_ENABLED')))
      throw new ServiceUnavailableException('Quotes are not enabled (QUOTES_ENABLED)');
  }
  private view(q: any, validateEdit = false) {
    return {
      ...q,
      ...computeStoredQuote(
        {
          currency: q.currency,
          taxEstimateCents: q.taxEstimateCents,
          lines: q.lines.map((l: any) => ({ ...l, qty: l.qty.toString() })),
        },
        { validateEdit },
      ),
    };
  }
  private async load(tx: WorkspaceTxClient, workspaceId: string, id: string) {
    const q = await tx.quote.findUnique({
      where: { workspaceId_id: { workspaceId, id } },
      include,
    });
    if (!q) throw new NotFoundException('Quote not found');
    return q;
  }
  private async changed(
    tx: WorkspaceTxClient,
    workspaceId: string,
    quoteId: string,
    kind: string,
    actor: string,
  ) {
    await tx.quoteEvent.create({ data: { workspaceId, quoteId, kind, actor } });
    await this.audit.logInTransaction(tx, {
      workspaceId,
      userId: actor,
      action: kind === 'create_quote' ? 'CREATE' : 'UPDATE',
      resource: 'quote',
      resourceId: quoteId,
      details: { kind },
    });
  }
  async execute(
    user: User,
    requestedWorkspace: string | null | undefined,
    action: string,
    args: any = {},
  ) {
    this.enabled();
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspace ?? null);
    const role = await this.membership.roleInWorkspace(user, workspaceId);
    const manage = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER].includes(
      role as any,
    );
    if (writes.has(action)) {
      if (![WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER].includes(role as any))
        throw new ForbiddenException('Quote mutations require workspace member role');
    }
    try {
      return await this.prisma.withWorkspace(workspaceId, ucUidOf(user), async (tx) => {
        if (action === 'list_price_book')
          return tx.priceBookItem.findMany({
            where: { workspaceId, active: true },
            orderBy: { sku: 'asc' },
          });
        if (!manage && ['get_quote', 'list_quotes'].includes(action)) {
          const where: any = { workspaceId };
          if (action === 'get_quote') where.id = z.string().uuid().parse(args.quote_id);
          if (args.customerId) where.customerId = z.string().uuid().parse(args.customerId);
          const rows = await tx.quote.findMany({
            where,
            select: {
              ...quoteSnapshotSelect,
              status: true,
              currentVersionNo: true,
              createdAt: true,
              updatedAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take:
              action === 'get_quote'
                ? 1
                : z.coerce.number().int().min(1).max(100).default(50).parse(args.limit),
          });
          if (action === 'get_quote' && !rows.length)
            throw new NotFoundException('Quote not found');
          const views = rows.map((row) => {
            const view = this.view(row);
            const { line_errors, option_group_errors, ...totals } = view.totals;
            return { ...view, totals };
          });
          return action === 'get_quote' ? views[0] : views;
        }
        if (action === 'list_quotes') {
          const limit = z.coerce.number().int().min(1).max(100).default(50).parse(args.limit);
          const customerId =
            args.customerId === undefined ? undefined : z.string().uuid().parse(args.customerId);
          const rows = await tx.quote.findMany({
            where: { workspaceId, customerId },
            include,
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return rows.map((q) => this.view(q));
        }
        if (action === 'create_quote') {
          const data = S.quoteCreate.parse(args.data);
          validateCurrency(data.currency);
          if (!(await tx.customer.findFirst({ where: { id: data.customerId, workspaceId } })))
            throw new NotFoundException('Customer not found');
          if (data.parentQuoteId) await this.load(tx, workspaceId, data.parentQuoteId);
          const year = new Date().getUTCFullYear();
          const counter = await tx.quoteCounter.upsert({
            where: { workspaceId_year: { workspaceId, year } },
            create: { workspaceId, year, lastNumber: 1 },
            update: { lastNumber: { increment: 1 } },
          });
          const q = await tx.quote.create({
            data: {
              ...data,
              workspaceId,
              createdBy: ucUidOf(user),
              number: `Q-${year}-${String(counter.lastNumber).padStart(4, '0')}`,
              validUntil: data.validUntil
                ? new Date(data.validUntil)
                : new Date(Date.now() + 30 * 86400000),
              splitRule: data.splitRule as any,
            },
            include,
          });
          const result = this.view(q, true);
          await this.changed(tx, workspaceId, q.id, action, ucUidOf(user));
          return result;
        }
        const id = z.string().uuid().parse(args.quote_id);
        if (action === 'get_quote') return this.view(await this.load(tx, workspaceId, id));
        if (!writes.has(action)) throw new BadRequestException('Unknown quote operation');
        // Serialize edits, options and future send locks on the same parent row.
        await tx.$queryRaw`SELECT id FROM quotes WHERE id=${id} AND workspace_id=${workspaceId} FOR UPDATE`;
        const q = await this.load(tx, workspaceId, id);
        if (q.status !== 'draft' || q.lockedForSend)
          throw new ConflictException('Only unlocked draft quotes may be edited');
        const key = { workspaceId, quoteId: id };
        if (action === 'update_quote') {
          const data = S.quoteUpdate.parse(args.data);
          if (data.currency) validateCurrency(data.currency);
          await tx.quote.update({
            where: { id },
            data: {
              ...data,
              validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
              splitRule: data.splitRule as any,
            },
          });
        } else if (action === 'add_quote_section') {
          if (q.sections.length >= 100)
            throw new BadRequestException('Quote section limit reached');
          await tx.quoteSection.create({ data: { ...key, ...S.sectionInput.parse(args.data) } });
        } else if (action === 'add_quote_line' || action === 'update_quote_line') {
          let prior: any;
          if (action === 'update_quote_line') {
            prior = q.lines.find((l) => l.id === args.line_id);
            if (!prior) throw new NotFoundException('Quote line not found');
          } else if (q.lines.length >= 500)
            throw new BadRequestException('Quote line limit reached');
          const patch = prior ? S.lineUpdate.parse(args.data) : S.lineInput.parse(args.data);
          const data = S.lineInput.parse(
            prior
              ? {
                  ...Object.fromEntries(
                    Object.keys(S.lineInput.shape).map((k) => [
                      k,
                      k === 'qty' ? prior.qty.toString() : prior[k],
                    ]),
                  ),
                  ...patch,
                }
              : patch,
          );
          if (data.sectionId && !q.sections.some((s) => s.id === data.sectionId))
            throw new NotFoundException('Quote section not found');
          if (
            data.priceBookItemId &&
            !(await tx.priceBookItem.findFirst({
              where: { id: data.priceBookItemId, workspaceId, active: true },
            }))
          )
            throw new NotFoundException('Price book item not found');
          if (
            patch.paymentSplit &&
            patch.milestone?.payment_split &&
            JSON.stringify(patch.paymentSplit) !== JSON.stringify(patch.milestone.payment_split)
          )
            throw new BadRequestException('Conflicting payment splits');
          const paymentSplit = patch.paymentSplit ??
            patch.milestone?.payment_split ??
            data.paymentSplit ?? [50, 50];
          const json = (v: any) => (v == null ? Prisma.DbNull : v);
          const payload = {
            ...data,
            paymentSplit,
            qty: new Prisma.Decimal(data.qty),
            recurring: json(data.recurring),
            hourly: json(data.hourly),
            milestone: json(
              data.milestone ? { ...data.milestone, payment_split: paymentSplit } : null,
            ),
            optionGroup: json(data.optionGroup),
          };
          if (prior) await tx.quoteLine.update({ where: { id: prior.id }, data: payload });
          else await tx.quoteLine.create({ data: { ...key, ...payload } });
        } else if (action === 'remove_quote_line') {
          const lineId = z.string().uuid().parse(args.line_id);
          if (!(await tx.quoteLine.deleteMany({ where: { ...key, id: lineId } })).count)
            throw new NotFoundException('Quote line not found');
        } else if (action === 'set_quote_options') {
          const { selectedLineIds } = S.optionsInput.parse(args.data);
          if (new Set(selectedLineIds).size !== selectedLineIds.length)
            throw new BadRequestException('Duplicate selected line');
          for (const selectedId of selectedLineIds)
            if (!q.lines.some((l) => l.id === selectedId && l.optionGroup))
              throw new BadRequestException('Option does not belong to this quote');
          for (const line of q.lines.filter((l) => l.optionGroup))
            await tx.quoteLine.update({
              where: { id: line.id },
              data: { selected: selectedLineIds.includes(line.id) },
            });
        } else if (action === 'set_quote_recipients') {
          const { recipients } = S.recipientsInput.parse(args.data);
          await tx.quoteRecipient.deleteMany({ where: key });
          for (const r of recipients)
            await tx.quoteRecipient.create({ data: { ...key, ...r, addedBy: ucUidOf(user) } });
        } else if (action === 'add_quote_cost')
          await tx.quoteCost.create({ data: { ...key, ...S.costInput.parse(args.data) } });
        else if (action === 'add_quote_attachment')
          await tx.quoteAttachment.create({
            data: { ...key, ...S.attachmentInput.parse(args.data) },
          });
        await tx.quote.update({ where: { id }, data: { updatedAt: new Date() } });
        const result = this.view(await this.load(tx, workspaceId, id), true);
        await this.changed(tx, workspaceId, id, action, ucUidOf(user));
        return result; // Invalid money/options rolls the whole edit back.
      });
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new BadRequestException(
          e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
        );
      if ((e as any).code === 'P2002') throw new ConflictException('Quote resource already exists');
      if ((e as any).code === 'P2003')
        throw new BadRequestException('Invalid quote resource reference');
      if (e instanceof QuoteComputationError) throw new BadRequestException(e.message);
      if (e instanceof Error && 'getStatus' in e) throw e;
      throw new ServiceUnavailableException('Quote persistence unavailable');
    }
  }
}
