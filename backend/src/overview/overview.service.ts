/**
 * OverviewService — the command-center "see the whole workspace at a glance"
 * aggregations.
 *
 * These power the top-level overview pages (invoices / outreach / email) that
 * roll up Customer-Ops's LOCAL link tables across the WHOLE workspace, so the
 * operator gets one fast, degrade-clean list instead of a live federation
 * fan-out per customer. Each row deep-links to a customer-360 for the live
 * detail (the customer-360 is where the real federation poll happens).
 *
 * The split this service honors (identical to CustomersService):
 *   - Every read runs through the GUC chokepoint
 *     (WorkspaceContextService.runForUser → PrismaService.withWorkspace), so the
 *     aggregate queries are tenant-scoped by RLS. The three link tables
 *     (customer_invoice_links / customer_outreach_links / customer_email_links)
 *     are RLS-fenced; this service never reaches around that.
 *   - The contact name/org on each row is FEDERATED from Contact-Ops at read
 *     time (ContactOpsPort.getContactSummaries), NEVER copied. It reuses the
 *     EXACT batch name-resolution the Relationships list uses (group the link
 *     rows' customerIds → resolve the distinct contactIds ONCE per request),
 *     with the same provisional-label fallback for ingested leads while
 *     Contact-Ops is dormant. A null name is the clean degrade — it never throws.
 *
 * Money is a decimal STRING on the wire (never a float) — matching the suite
 * money shape + the link tables' own NUMERIC(20,4) columns.
 *
 * These are READ-ONLY rollups of links Customer-Ops already persists. This
 * service is NOT a second invoicing/campaign/mail engine: it polls nothing,
 * writes nothing, and federates only the contact label.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WithWorkspaceClaim, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort, FederationContext } from '../contact-ops/contact-ops.port';
import { LeadLabelResolver, isProvisionalContactId } from '../lead-intake/lead-label.port';

/**
 * The cap on rows returned by each overview list. The command-center views are a
 * glance + a deep-link, not a paginated grid; a sane ceiling keeps the single
 * batch name-resolve bounded and the response fast. Newest links win when a
 * workspace exceeds it (the query orders createdAt desc + takes this many).
 */
export const OVERVIEW_ITEM_CAP = 500;

/** One invoice link as the command-center invoices overview renders it. */
export interface InvoiceRow {
  customerId: string;
  /** Federated from Contact-Ops at read time; null when CO is dormant/unresolved. */
  contactName: string | null;
  contactOrg: string | null;
  invoiceNumber: string | null;
  lastStatus: string | null;
  currency: string;
  /** Decimal string (NUMERIC(20,4)); never a float. */
  totalAmount: string | null;
  lastBalanceDue: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

/** One outreach link as the command-center outreach overview renders it. */
export interface OutreachRow {
  customerId: string;
  contactName: string | null;
  channel: 'email' | 'social';
  campaignName: string | null;
  lastStatus: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

/** One email link as the command-center email overview renders it. */
export interface EmailRow {
  customerId: string;
  contactName: string | null;
  type: 'send' | 'draft';
  lastStatus: string | null;
  externalRef: string;
  createdAt: string;
}

@Injectable()
export class OverviewService {
  private readonly logger = new Logger(OverviewService.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    // Resolves a real label for a PROVISIONAL contactId ('prov:…') from the
    // lead-intake buffer while Contact-Ops is dormant — the SAME fallback the
    // Relationships list (CustomersService.joinContacts) uses. @Optional so the
    // overview layer has no hard dependency on the ingestion module.
    @Optional()
    @Inject(LeadLabelResolver)
    private readonly leadLabels?: LeadLabelResolver,
  ) {}

  // ========================================================================
  // PUBLIC ENTRY POINTS — one RLS-scoped aggregate read + one batched contact
  // name-resolve per request, then shape to the wire row + summary.
  // ========================================================================

  /**
   * The workspace-wide invoices overview: every CustomerInvoiceLink (newest
   * first, capped), each with its federated contact label and a summary
   * (count, per-status counts, total outstanding, currency). Degrade-clean:
   * empty arrays + a zero summary when no links exist.
   *
   * `totalOutstanding` = the sum of lastBalanceDue across links whose lastStatus
   * is NOT paid/void (an unpaid balance is what the command center watches);
   * `byStatus` = a count per lastStatus value ('unknown' when a link has no
   * cached status yet). The currency on the summary is the dominant link
   * currency (overview is single-glance, not multi-currency math).
   */
  async invoicesForUser(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<{
    items: InvoiceRow[];
    summary: {
      count: number;
      byStatus: Record<string, number>;
      totalOutstanding: string;
      currency: string;
    };
  }> {
    // The invoice link table (unlike outreach/email) has NO contactId column —
    // the contact is reached THROUGH its parent Customer relationship. So in the
    // SAME RLS transaction, read the links AND the customerId→contactId map for
    // the distinct customers on those links (both workspace-scoped); the email/
    // outreach paths carry contactId on the row and skip this second query.
    const { links, contactByCustomer } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const links = await tx.customerInvoiceLink.findMany({
          orderBy: { createdAt: 'desc' },
          take: OVERVIEW_ITEM_CAP,
        });
        const customerIds = [...new Set(links.map((l) => l.customerId))];
        const customers = customerIds.length
          ? await tx.customer.findMany({
              where: { id: { in: customerIds } },
              select: { id: true, contactId: true },
            })
          : [];
        const contactByCustomer = new Map(customers.map((c) => [c.id, c.contactId]));
        return { links, contactByCustomer };
      },
      requestedWorkspaceId,
    );

    // Pair each link with the contactId resolved via its parent Customer (rows
    // whose customer is missing simply resolve to a null name — degrade-clean).
    const pairs = links
      .map((l) => ({ customerId: l.customerId, contactId: contactByCustomer.get(l.customerId) }))
      .filter((p): p is { customerId: string; contactId: string } => p.contactId !== undefined);
    const names = await this.resolveNames(user, pairs, requestedWorkspaceId);

    const items: InvoiceRow[] = links.map((l) => {
      const name = names.get(l.customerId);
      return {
        customerId: l.customerId,
        contactName: name?.displayName ?? null,
        contactOrg: name?.currentOrgName ?? null,
        invoiceNumber: l.invoiceNumber ?? null,
        lastStatus: l.lastStatus ?? null,
        currency: l.currency ?? 'USD',
        totalAmount: this.decimalString(l.totalAmount),
        lastBalanceDue: this.decimalString(l.lastBalanceDue),
        lastPolledAt: this.isoString(l.lastPolledAt),
        createdAt: this.isoString(l.createdAt)!,
      };
    });

    // Summary: per-status counts + the outstanding (non-paid/non-void) balance,
    // summed as Decimal so the wire string stays exact (never a float roundtrip).
    const byStatus: Record<string, number> = {};
    let outstanding = new Prisma.Decimal(0);
    let currency = 'USD';
    const currencyVotes: Record<string, number> = {};
    for (const l of links) {
      const status = l.lastStatus ?? 'unknown';
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      const cur = l.currency ?? 'USD';
      currencyVotes[cur] = (currencyVotes[cur] ?? 0) + 1;

      const settled = status === 'paid' || status === 'void';
      if (!settled && l.lastBalanceDue != null) {
        outstanding = outstanding.add(new Prisma.Decimal(l.lastBalanceDue));
      }
    }
    // The dominant currency across the links (a single-glance label; the rows
    // carry their own per-link currency for the detail).
    let max = 0;
    for (const [cur, votes] of Object.entries(currencyVotes)) {
      if (votes > max) {
        max = votes;
        currency = cur;
      }
    }

    return {
      items,
      summary: {
        count: links.length,
        byStatus,
        totalOutstanding: outstanding.toString(),
        currency,
      },
    };
  }

  /**
   * The workspace-wide outreach overview: every CustomerOutreachLink (newest
   * first, capped), each with its federated contact label and a summary
   * (count + per-status counts). Degrade-clean: empty arrays when none exist.
   */
  async outreachForUser(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<{
    items: OutreachRow[];
    summary: { count: number; byStatus: Record<string, number> };
  }> {
    const links = await this.workspaces.runForUser(
      user,
      (tx) =>
        tx.customerOutreachLink.findMany({
          orderBy: { createdAt: 'desc' },
          take: OVERVIEW_ITEM_CAP,
        }),
      requestedWorkspaceId,
    );

    const names = await this.resolveNames(user, links, requestedWorkspaceId);

    const items: OutreachRow[] = links.map((l) => ({
      customerId: l.customerId,
      contactName: names.get(l.customerId)?.displayName ?? null,
      // The column is a free TEXT defaulting to 'email'; normalize to the union.
      channel: l.channel === 'social' ? 'social' : 'email',
      campaignName: l.campaignName ?? null,
      lastStatus: l.lastStatus ?? null,
      lastPolledAt: this.isoString(l.lastPolledAt),
      createdAt: this.isoString(l.createdAt)!,
    }));

    const byStatus: Record<string, number> = {};
    for (const l of links) {
      const status = l.lastStatus ?? 'unknown';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }

    return { items, summary: { count: links.length, byStatus } };
  }

  /**
   * The workspace-wide email overview: every CustomerEmailLink (newest first,
   * capped), each with its federated contact label and a summary (count + a
   * send/draft split). Degrade-clean: empty arrays when none exist.
   *
   * The link's column is `mode` ('send'|'draft'); the wire field is `type` per
   * the command-center contract — they are the same value, renamed at the seam.
   */
  async emailForUser(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<{
    items: EmailRow[];
    summary: { count: number; byType: { send: number; draft: number } };
  }> {
    const links = await this.workspaces.runForUser(
      user,
      (tx) =>
        tx.customerEmailLink.findMany({
          orderBy: { createdAt: 'desc' },
          take: OVERVIEW_ITEM_CAP,
        }),
      requestedWorkspaceId,
    );

    const names = await this.resolveNames(user, links, requestedWorkspaceId);

    const items: EmailRow[] = links.map((l) => ({
      customerId: l.customerId,
      contactName: names.get(l.customerId)?.displayName ?? null,
      // The column is a free TEXT defaulting to 'send'; normalize to the union.
      type: l.mode === 'draft' ? 'draft' : 'send',
      lastStatus: l.lastStatus ?? null,
      externalRef: l.externalRef,
      createdAt: this.isoString(l.createdAt)!,
    }));

    let send = 0;
    let draft = 0;
    for (const l of links) {
      if (l.mode === 'draft') draft += 1;
      else send += 1;
    }

    return { items, summary: { count: links.length, byType: { send, draft } } };
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

  /**
   * Resolve the federated contact label (display name + org) for a batch of
   * `{ customerId, contactId }` pairs, keyed by `customerId`. This is the EXACT
   * name-resolution the Relationships list uses (CustomersService.joinContacts),
   * adapted to a customerId→label map. (The outreach/email links carry contactId
   * on the row; the invoice link reaches it through its parent Customer — the
   * caller supplies the pair either way, so this helper does no DB work.)
   *
   *   1. Group the pairs' DISTINCT contactIds and resolve them in ONE Contact-Ops
   *      batch call (getContactSummaries). One round-trip per request, never per
   *      row.
   *   2. For any contactId the canonical phonebook did NOT resolve AND that is a
   *      local provisional id ('prov:…'), fall back to the lead-intake buffer
   *      label (so an ingested lead still renders a real name while Contact-Ops
   *      is dormant). One batch lead-label call, only for the unresolved
   *      provisional ids.
   *
   * Returns a `customerId → { displayName, currentOrgName }` map (the rows join
   * by customerId). Best-effort + degrade-clean: a federation failure or a
   * dormant Contact-Ops yields an empty/partial map, never an exception — the
   * rows render with null name/org.
   */
  private async resolveNames(
    user: User & Partial<WithWorkspaceClaim>,
    links: Array<{ customerId: string; contactId: string }>,
    requestedWorkspaceId?: string | null,
  ): Promise<Map<string, { displayName: string; currentOrgName: string | null }>> {
    const byCustomer = new Map<string, { displayName: string; currentOrgName: string | null }>();
    if (links.length === 0) return byCustomer;

    // The distinct contactIds to resolve + the contactId→customerIds reverse map
    // (several links/customers can share a contactId; we resolve each id once).
    const contactIds = [...new Set(links.map((l) => l.contactId))];
    const customersByContact = new Map<string, string[]>();
    for (const l of links) {
      const list = customersByContact.get(l.contactId);
      if (list) list.push(l.customerId);
      else customersByContact.set(l.contactId, [l.customerId]);
    }

    // The resolved label per contactId (Contact-Ops first, provisional fallback).
    const byContact = new Map<string, { displayName: string; currentOrgName: string | null }>();

    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    try {
      const summaries = await this.contactOps.getContactSummaries(fedCtx, contactIds);
      for (const [id, s] of summaries) {
        byContact.set(id, { displayName: s.displayName, currentOrgName: s.currentOrgName });
      }
    } catch (err) {
      // Degrade-clean: a Contact-Ops outage leaves names null, never breaks the
      // overview (the link rows are the source of truth; the name is enrichment).
      this.logger.warn(`Contact name resolution failed: ${(err as Error).message}`);
    }

    // Provisional fallback for ingested leads while Contact-Ops is dormant — the
    // same fallback CustomersService.joinContacts applies, batched once.
    if (this.leadLabels) {
      const unresolvedProvisional = contactIds.filter(
        (id) => isProvisionalContactId(id) && !byContact.has(id),
      );
      if (unresolvedProvisional.length) {
        try {
          const labels = await this.leadLabels.labels(
            user,
            requestedWorkspaceId ?? null,
            unresolvedProvisional,
          );
          for (const [id, l] of labels) {
            byContact.set(id, { displayName: l.displayName, currentOrgName: l.currentOrgName });
          }
        } catch (err) {
          this.logger.warn(`Provisional label resolution failed: ${(err as Error).message}`);
        }
      }
    }

    // Fan the per-contact labels back out to each customerId.
    for (const [contactId, label] of byContact) {
      for (const customerId of customersByContact.get(contactId) ?? []) {
        byCustomer.set(customerId, label);
      }
    }
    return byCustomer;
  }

  /** Build the federation identity for the user's resolved workspace (same shape
   *  CustomersService uses for the contact seam: workspace + actor). */
  private async federationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<FederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return { workspaceId, ucUid: ucUidOf(user) || null };
  }

  /** A Prisma Decimal column → wire string (null-preserving). Never a float. */
  private decimalString(value: Prisma.Decimal | null | undefined): string | null {
    return value !== null && value !== undefined ? value.toString() : null;
  }

  /** A Date column → ISO-8601 string (null-preserving). */
  private isoString(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
  }
}
