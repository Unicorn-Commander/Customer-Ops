/**
 * CustomersService — the relationship logic of the Customer-Ops cockpit.
 *
 * Customer-Ops OWNS the relationship + the lifecycle stage; it FEDERATES the
 * contact details. This service is where that split lives:
 *
 *   - Relationship reads/writes go through the GUC chokepoint
 *     (WorkspaceContextService.runForUser → PrismaService.withWorkspace), so
 *     every query is tenant-scoped by RLS. The `customers` + `customer_activities`
 *     tables are RLS-fenced; this service never reaches around that.
 *   - Stage transitions enforce the funnel rules (funnel.ts) and write an
 *     append-only CustomerActivity row in the SAME transaction, so the timeline
 *     can never drift from the stage.
 *   - The customer-360 stitches the LOCAL relationship together with the
 *     FEDERATED contact (ContactOpsPort.getContact) and the FEDERATED
 *     Accounting-Ops invoice panel (AccountingOpsPort; AO is the ledger SoR —
 *     Customer-Ops keeps only a thin link), leaving meeting/email as later-phase
 *     seams — never copying the contact or posting a ledger entry.
 *
 * The methods that mutate or read relationship state accept a transaction
 * client (`tx`) so the orchestration (workspace resolution + GUC) is decoupled
 * from the relationship logic and the logic is unit-testable with a fake tx.
 * The public entry points (`*ForUser`) wrap them in the workspace transaction.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CustomerActivityKind, Prisma, RelationshipStage, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, entitlementsOf, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort, FederationContext } from '../contact-ops/contact-ops.port';
import {
  AccountingOpsPort,
  FederationContext as InvoiceFederationContext,
} from '../accounting-ops/accounting-ops.port';
import { FederatedInvoice, InvoiceDraft } from '../accounting-ops/accounting-ops.types';
import { checkTransition, STAGE_ORDER } from './funnel';
import {
  AddNoteDto,
  CreateCustomerDto,
  CreateInvoiceDto,
  ListCustomersQueryDto,
  MarkLostDto,
  TransitionStageDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

/** A relationship row joined with its (optional) federated contact summary. */
export interface CustomerWithContact {
  id: string;
  contactId: string;
  stage: RelationshipStage;
  priority: string;
  source: string | null;
  notes: string | null;
  ownerUserKey: string | null;
  expectedValue: string | null;
  currency: string | null;
  nextActionAt: Date | null;
  isLost: boolean;
  lostReason: string | null;
  closedLostAt: Date | null;
  lastStageChangeAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /** Federated from Contact-Ops at read time. null when CO is dormant/unknown. */
  contact: {
    displayName: string;
    primaryEmail: string | null;
    currentOrgName: string | null;
    tags: string[];
  } | null;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly accountingOps: AccountingOpsPort,
  ) {}

  // ========================================================================
  // PUBLIC ENTRY POINTS — resolve workspace + open the RLS transaction, then
  // delegate to the tx-scoped relationship logic. `requestedWorkspaceId` flows
  // the §D4 addressing precedence (the guard/controller passes req.workspaceId).
  // ========================================================================

  async listForUser(
    user: User & Partial<WithWorkspaceClaim>,
    query: ListCustomersQueryDto,
    requestedWorkspaceId?: string | null,
  ) {
    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    const rows = await this.workspaces.runForUser(
      user,
      (tx) => this.listInTx(tx, query),
      requestedWorkspaceId,
    );
    const withContacts = query.withContacts ?? true;
    const joined = await this.joinContacts(fedCtx, rows, withContacts);
    return { items: joined, count: joined.length };
  }

  async getForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    requestedWorkspaceId?: string | null,
  ): Promise<CustomerWithContact> {
    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    const row = await this.workspaces.runForUser(
      user,
      (tx) => this.getInTx(tx, id),
      requestedWorkspaceId,
    );
    const [joined] = await this.joinContacts(fedCtx, [row], true);
    return joined;
  }

  /**
   * The customer-360: the LOCAL relationship + its timeline + the FEDERATED
   * contact + the FEDERATED Accounting-Ops invoice panel (live status), with
   * meeting/email left as later-phase seams.
   */
  async customer360ForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    requestedWorkspaceId?: string | null,
  ) {
    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    const { relationship, activities, invoiceLinks } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const relationship = await this.getInTx(tx, id);
        const activities = await tx.customerActivity.findMany({
          where: { customerId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
        // The thin local invoice links for this customer (RLS-scoped). AO is the
        // ledger SoR; these are just the (source, ref) memory + cached status.
        const invoiceLinks = await tx.customerInvoiceLink.findMany({
          where: { customerId: id },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        return { relationship, activities, invoiceLinks };
      },
      requestedWorkspaceId,
    );

    // Federate the contact detail (read-time; never persisted).
    const contact = await this.contactOps.getContact(fedCtx, relationship.contactId);

    // Federate the invoice panel: poll AO for each linked invoice's live status
    // (best-effort; degrade-clean). Outside the DB tx — federation must not hold
    // a transaction open. Refreshes the cached projection on the link rows.
    const invoices = await this.buildInvoicePanel(user, invoiceLinks, requestedWorkspaceId);

    return {
      relationship: this.serialize(relationship),
      // The FEDERATED contact half — resolved from Contact-Ops, not stored here.
      contact: contact ?? null,
      contactFederation: {
        contactId: relationship.contactId,
        resolved: contact !== null,
        source: 'contact-ops',
      },
      timeline: activities.map((a) => ({
        id: a.id,
        kind: a.kind,
        fromStage: a.fromStage,
        toStage: a.toStage,
        body: a.body,
        actorUcUid: a.actorUcUid,
        createdAt: a.createdAt,
      })),
      // ── Phase-3: the Accounting-Ops invoice panel (federated, live status) ──
      invoices,
      // ── Later-phase federation slots (intentionally empty; seams only) ──
      // Meeting-Ops: meetings/action-items. Email-Ops: Stalwart threads.
      // Outreach: campaign membership.
      meetings: { federated: false, source: 'meeting-ops', items: [] as unknown[] },
      email: { federated: false, source: 'email-ops', items: [] as unknown[] },
    };
  }

  async createForUser(
    user: User & Partial<WithWorkspaceClaim>,
    dto: CreateCustomerDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const row = await this.workspaces.runForUser(
      user,
      (tx) => this.createInTx(tx, dto, ucUid),
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  async updateForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: UpdateCustomerDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const row = await this.workspaces.runForUser(
      user,
      (tx) => this.updateInTx(tx, id, dto, ucUid),
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  async transitionForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: TransitionStageDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const row = await this.workspaces.runForUser(
      user,
      (tx) => this.transitionInTx(tx, id, dto.toStage, dto.note, ucUid),
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  async markLostForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: MarkLostDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const row = await this.workspaces.runForUser(
      user,
      (tx) => this.markLostInTx(tx, id, dto.reason, ucUid),
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  async reopenForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const row = await this.workspaces.runForUser(
      user,
      (tx) => this.reopenInTx(tx, id, ucUid),
      requestedWorkspaceId,
    );
    return this.serialize(row);
  }

  async addNoteForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: AddNoteDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    return this.workspaces.runForUser(
      user,
      (tx) => this.addNoteInTx(tx, id, dto.body, ucUid),
      requestedWorkspaceId,
    );
  }

  /**
   * Pipeline board: every non-lost relationship bucketed by stage, with a
   * per-lane count + summed expected value, plus the (optionally federated)
   * contact label on each card. The classic kanban data shape.
   */
  async pipelineForUser(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
    withContacts = true,
  ) {
    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    const rows = await this.workspaces.runForUser(
      user,
      (tx) =>
        tx.customer.findMany({
          where: { isLost: false },
          orderBy: [{ priority: 'desc' }, { lastStageChangeAt: 'asc' }],
        }),
      requestedWorkspaceId,
    );
    const joined = await this.joinContacts(fedCtx, rows, withContacts);

    const lanes = STAGE_ORDER.map((stage) => {
      const cards = joined.filter((c) => c.stage === stage);
      const value = cards.reduce((sum, c) => sum + Number(c.expectedValue ?? 0), 0);
      return {
        stage,
        count: cards.length,
        expectedValue: value.toFixed(2),
        cards,
      };
    });
    return {
      lanes,
      totals: {
        count: joined.length,
        expectedValue: joined.reduce((s, c) => s + Number(c.expectedValue ?? 0), 0).toFixed(2),
      },
    };
  }

  // ========================================================================
  // PHASE 3 — INVOICING SURFACE (the Accounting-Ops AR federation seam).
  //
  // Customer-Ops FEDERATES invoicing: AO is the AR engine + the ledger
  // system-of-record. These entry points (a) assemble a draft and call AO's
  // native create_invoice_from_draft (idempotent on (workspace, source, ref)),
  // keeping only a thin local CustomerInvoiceLink, and (b) poll AO get_invoice
  // for live status. They NEVER post a ledger entry or store line detail.
  // ========================================================================

  /**
   * The customer's invoices: the local links joined with AO's live status
   * (polled). Degrade-clean: when AO is unconfigured the panel reports
   * `configured:false` ("connect Accounting-Ops") and no call is made; when the
   * caller lacks the dual SKU it reports `entitled:false`. The list still shows
   * whatever links exist (with their last-cached status) so history is never
   * hidden by a transient AO outage.
   */
  async invoicesForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ) {
    const links = await this.workspaces.runForUser(
      user,
      async (tx) => {
        // Confirm the relationship exists in this workspace (404 otherwise),
        // then read its links — both RLS-scoped.
        await this.getInTx(tx, customerId);
        return tx.customerInvoiceLink.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
      },
      requestedWorkspaceId,
    );
    return this.buildInvoicePanel(user, links, requestedWorkspaceId);
  }

  /**
   * Create an invoice for this customer in Accounting-Ops and record a thin
   * local link. Gated on BOTH customer-ops AND accounting-ops entitlements
   * (UC_ENTITLEMENT_MODE=open bypasses with a WARN); 403 when not entitled,
   * 400 when AO is unconfigured (degrade-clean — nothing to call), 502 when AO
   * is reachable but the call fails. Idempotent: the deterministic external_ref
   * (derived from the optional idempotencyKey) means a retry returns the same AO
   * invoice and upserts the same link.
   */
  async createInvoiceForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    dto: CreateInvoiceDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const fedCtx = await this.invoiceFederationContext(user, requestedWorkspaceId);

    // Degrade-clean: no AO target → make no call, surface a clean affordance.
    if (!this.accountingOps.isConfigured()) {
      throw new BadRequestException(
        'Accounting-Ops is not connected for this deployment. Set AO_BASE_URL to ' +
          'enable invoicing. (Customer-Ops federates AR to Accounting-Ops; it is ' +
          'not an invoicing engine.)',
      );
    }

    // Dual-SKU gate (pre-check; the client re-checks as defense-in-depth).
    const gate = this.accountingOps.checkEntitlement(fedCtx);
    if (!gate.allowed) {
      this.logger.warn(
        `Invoice create denied for ${ucUid} (ws=${fedCtx.workspaceId}): ${gate.reason}`,
      );
      throw new ForbiddenException(gate.reason);
    }

    // The deterministic idempotency key → external_ref. A caller-supplied key
    // makes a retry idempotent; otherwise we mint one (a fresh invoice).
    const idemKey = dto.idempotencyKey?.trim() || randomUUID();
    const externalSource = 'customer-ops';
    const externalRef = `cust:${customerId}:${idemKey}`;

    // 1) Resolve the relationship (404 if absent) + record/locate the link FIRST
    //    so the (source, ref) is durably remembered even if the AO call fails
    //    mid-flight — the next poll/retry reuses the same ref (idempotent).
    const link = await this.workspaces.runForUser(
      user,
      async (tx) => {
        await this.getInTx(tx, customerId);
        const workspaceId = await this.boundWorkspaceId(tx);
        const existing = await tx.customerInvoiceLink.findUnique({
          where: {
            workspaceId_externalSource_externalRef: {
              workspaceId,
              externalSource,
              externalRef,
            },
          },
        });
        if (existing) return existing;
        return tx.customerInvoiceLink.create({
          data: {
            workspaceId,
            customerId,
            externalSource,
            externalRef,
            entityId: dto.entityId,
            currency: dto.currency ?? 'USD',
            createdByUcUid: ucUid || null,
          },
        });
      },
      requestedWorkspaceId,
    );

    // 2) Call AO create_invoice_from_draft (idempotent on the tuple). Outside the
    //    DB tx (federation must not hold a transaction open).
    const draft = this.assembleDraft(dto, externalSource, externalRef);
    const invoice = await this.accountingOps.createInvoice(fedCtx, draft);
    if (!invoice) {
      // AO was reachable+entitled (we gated above) but the call failed. The link
      // persists (status pending) so the cockpit shows the attempt + can retry.
      throw new ServiceUnavailableException(
        'Accounting-Ops did not return an invoice. The link is recorded; retry ' +
          'to complete it (the create is idempotent on the same reference).',
      );
    }

    // 3) Refresh the link's cached projection + log the relationship activity
    //    (one tx; RLS-scoped). The activity records the AO invoice number — the
    //    ledger itself lives in AO.
    const refreshed = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const updated = await tx.customerInvoiceLink.update({
          where: { id: link.id },
          data: this.invoiceCacheUpdate(invoice),
        });
        await this.logActivity(tx, updated.workspaceId, customerId, {
          kind: CustomerActivityKind.INVOICE_CREATED,
          body:
            `Invoice ${invoice.invoiceNumber ?? invoice.id} (${invoice.status}) ` +
            `created in Accounting-Ops · ref ${externalRef}`,
          actorUcUid: ucUid,
        });
        return updated;
      },
      requestedWorkspaceId,
    );

    return {
      link: this.serializeInvoiceLink(refreshed),
      invoice,
    };
  }

  // ---- invoicing helpers --------------------------------------------------

  /** Build the invoice federation identity (workspace + actor + entitlements). */
  private async invoiceFederationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<InvoiceFederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return {
      workspaceId,
      ucUid: ucUidOf(user) || null,
      entitlements: entitlementsOf(user),
    };
  }

  /**
   * Assemble the customer-360 invoice panel: poll AO for each link's live status
   * (when configured + entitled), refresh the cached projection, and return the
   * panel shape the cockpit renders. Never throws (federation best-effort).
   */
  private async buildInvoicePanel(
    user: User & Partial<WithWorkspaceClaim>,
    links: Array<Record<string, any>>,
    requestedWorkspaceId?: string | null,
  ) {
    const configured = this.accountingOps.isConfigured();
    const fedCtx = configured
      ? await this.invoiceFederationContext(user, requestedWorkspaceId)
      : null;
    const entitled = fedCtx ? this.accountingOps.checkEntitlement(fedCtx).allowed : false;

    let items = links.map((l) => this.serializeInvoiceLink(l));

    // Poll live status only when AO is configured (reads are viewer-level on AO,
    // so a poll does NOT require the dual SKU — history stays visible). Refresh
    // the cache best-effort; a failed poll leaves the last-cached status.
    if (configured && fedCtx && links.length > 0) {
      const refreshed = await Promise.all(
        links.map((l) => this.pollAndRefreshLink(user, fedCtx, l, requestedWorkspaceId)),
      );
      items = refreshed;
    }

    return {
      federated: configured,
      source: 'accounting-ops',
      // Render affordances for the cockpit (degrade-clean / entitlement states).
      configured,
      entitled,
      // When AO is configured but the caller lacks the dual SKU, the create
      // action is hidden; reads still show cached history.
      canCreate: configured && entitled,
      items,
    };
  }

  /**
   * Poll one link via AO get_invoice (by AO id if known, else by (source, ref))
   * and refresh its cached projection. Returns the serialized (refreshed) link.
   * Best-effort: a poll failure returns the link unchanged (last-cached).
   */
  private async pollAndRefreshLink(
    user: User & Partial<WithWorkspaceClaim>,
    fedCtx: InvoiceFederationContext,
    link: Record<string, any>,
    requestedWorkspaceId?: string | null,
  ) {
    let invoice: FederatedInvoice | null = null;
    try {
      invoice = link.aoInvoiceId
        ? await this.accountingOps.getInvoiceById(fedCtx, link.aoInvoiceId)
        : await this.accountingOps.getInvoiceByRef(fedCtx, link.externalSource, link.externalRef);
    } catch (err) {
      this.logger.warn(`AO poll failed for link ${link.id}: ${(err as Error).message}`);
    }
    if (!invoice) return this.serializeInvoiceLink(link);

    // Persist the refreshed cache (RLS-scoped). Best-effort — a write failure
    // must not break rendering.
    try {
      const updated = await this.workspaces.runForUser(
        user,
        (tx) =>
          tx.customerInvoiceLink.update({
            where: { id: link.id },
            data: this.invoiceCacheUpdate(invoice!),
          }),
        requestedWorkspaceId,
      );
      return this.serializeInvoiceLink(updated);
    } catch (err) {
      this.logger.warn(`AO link cache refresh failed for ${link.id}: ${(err as Error).message}`);
      // Return the freshly-polled values even if the cache write didn't land.
      return { ...this.serializeInvoiceLink(link), ...this.invoiceProjection(invoice) };
    }
  }

  /** The Prisma update payload that refreshes a link's cached AO projection. */
  private invoiceCacheUpdate(invoice: FederatedInvoice): Prisma.CustomerInvoiceLinkUpdateInput {
    return {
      aoInvoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber ?? undefined,
      lastStatus: invoice.status,
      currency: invoice.currency ?? undefined,
      totalAmount: invoice.total != null ? new Prisma.Decimal(invoice.total) : null,
      lastBalanceDue: invoice.balanceDue != null ? new Prisma.Decimal(invoice.balanceDue) : null,
      lastPolledAt: new Date(),
    };
  }

  /** The (non-persisted) projection fields from a freshly-polled AO invoice. */
  private invoiceProjection(invoice: FederatedInvoice) {
    return {
      aoInvoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      currency: invoice.currency,
      total: invoice.total,
      balanceDue: invoice.balanceDue,
    };
  }

  /** Map a CreateInvoiceDto + the idempotency tuple to an AO draft. */
  private assembleDraft(
    dto: CreateInvoiceDto,
    externalSource: string,
    externalRef: string,
  ): InvoiceDraft {
    return {
      entityId: dto.entityId,
      externalSource,
      externalRef,
      customer: {
        name: dto.customerName,
        email: dto.customerEmail ?? null,
        billingAddress: dto.billingAddress ?? null,
      },
      lineItems: dto.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity ?? '1',
        unitPrice: li.unitPrice ?? '0',
        amount: li.amount ?? null,
        taxCode: li.taxCode ?? null,
        taxAmount: li.taxAmount ?? null,
        revenueAccountId: li.revenueAccountId ?? null,
        sourceRef: li.sourceRef ?? null,
      })),
      currency: dto.currency ?? 'USD',
      issueDate: dto.issueDate ?? null,
      dueDate: dto.dueDate ?? null,
      netTerms: dto.netTerms ?? null,
      discount: dto.discount ?? null,
      notes: dto.notes ?? null,
      poNumber: dto.poNumber ?? null,
      autoSend: dto.autoSend ?? false,
    };
  }

  /** Serialize a CustomerInvoiceLink row to the wire shape (Decimal → string). */
  private serializeInvoiceLink(row: Record<string, any>) {
    return {
      id: row.id,
      customerId: row.customerId,
      externalSource: row.externalSource,
      externalRef: row.externalRef,
      entityId: row.entityId,
      aoInvoiceId: row.aoInvoiceId ?? null,
      invoiceNumber: row.invoiceNumber ?? null,
      status: row.lastStatus ?? null,
      currency: row.currency ?? 'USD',
      total:
        row.totalAmount !== null && row.totalAmount !== undefined
          ? row.totalAmount.toString()
          : null,
      balanceDue:
        row.lastBalanceDue !== null && row.lastBalanceDue !== undefined
          ? row.lastBalanceDue.toString()
          : null,
      lastPolledAt: row.lastPolledAt ?? null,
      createdAt: row.createdAt,
    };
  }

  // ========================================================================
  // TX-SCOPED RELATIONSHIP LOGIC (pure-ish; takes the workspace-bound tx).
  // Unit-testable with a fake tx. These run INSIDE the RLS transaction, so
  // every query is already workspace-scoped — the WHERE clauses never need a
  // workspaceId (RLS adds it), but writes set it from the GUC via the trigger-
  // free WITH CHECK, so inserts MUST carry the workspaceId. We read it back
  // from the GUC-bound row's own workspaceId on the relationship for writes.
  // ========================================================================

  async listInTx(tx: WorkspaceTxClient, query: ListCustomersQueryDto) {
    const where: Prisma.CustomerWhereInput = {};
    if (query.stage) where.stage = query.stage;
    if (query.priority) where.priority = query.priority;
    if (query.ownerUserKey) where.ownerUserKey = query.ownerUserKey;
    if (!query.includeLost) where.isLost = false;

    return tx.customer.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { lastStageChangeAt: 'asc' }],
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
    });
  }

  async getInTx(tx: WorkspaceTxClient, id: string) {
    const row = await tx.customer.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Customer ${id} not found`);
    return row;
  }

  async createInTx(tx: WorkspaceTxClient, dto: CreateCustomerDto, ucUid: string) {
    // The workspaceId is the GUC the transaction is bound to; read it so the
    // insert satisfies the RLS WITH CHECK (workspaceId = current_workspace_id()).
    const workspaceId = await this.boundWorkspaceId(tx);

    // One relationship per (workspace, contact). Surface the clash cleanly.
    const existing = await tx.customer.findFirst({ where: { contactId: dto.contactId } });
    if (existing) {
      throw new ConflictException(
        `A relationship for contact ${dto.contactId} already exists in this workspace`,
      );
    }

    const created = await tx.customer.create({
      data: {
        workspaceId,
        contactId: dto.contactId,
        stage: dto.stage ?? RelationshipStage.LEAD,
        priority: dto.priority,
        source: dto.source,
        notes: dto.notes,
        ownerUserKey: dto.ownerUserKey,
        expectedValue: dto.expectedValue ? new Prisma.Decimal(dto.expectedValue) : undefined,
        currency: dto.currency,
        lastStageChangeAt: new Date(),
      },
    });

    await this.logActivity(tx, workspaceId, created.id, {
      kind: CustomerActivityKind.CREATED,
      toStage: created.stage,
      body: dto.source ? `Sourced from ${dto.source}` : 'Relationship created',
      actorUcUid: ucUid,
    });
    return created;
  }

  async updateInTx(tx: WorkspaceTxClient, id: string, dto: UpdateCustomerDto, ucUid: string) {
    const current = await this.getInTx(tx, id);
    const data: Prisma.CustomerUpdateInput = {};
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.source !== undefined) data.source = dto.source;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.expectedValue !== undefined) {
      data.expectedValue = dto.expectedValue ? new Prisma.Decimal(dto.expectedValue) : null;
    }
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.nextActionAt !== undefined) {
      data.nextActionAt = dto.nextActionAt ? new Date(dto.nextActionAt) : null;
    }

    // Owner reassignment is a logged relationship event.
    const ownerChanged =
      dto.ownerUserKey !== undefined && dto.ownerUserKey !== current.ownerUserKey;
    if (dto.ownerUserKey !== undefined) data.ownerUserKey = dto.ownerUserKey;

    const updated = await tx.customer.update({ where: { id }, data });

    if (ownerChanged) {
      await this.logActivity(tx, updated.workspaceId, id, {
        kind: CustomerActivityKind.OWNER_CHANGED,
        body: `Owner → ${dto.ownerUserKey ?? '(unassigned)'}`,
        actorUcUid: ucUid,
      });
    }
    return updated;
  }

  async transitionInTx(
    tx: WorkspaceTxClient,
    id: string,
    toStage: RelationshipStage,
    note: string | undefined,
    ucUid: string,
  ) {
    const current = await this.getInTx(tx, id);
    const check = checkTransition(current.stage, toStage);
    if (!check.allowed) {
      throw new BadRequestException(`Illegal stage transition: ${check.reason}`);
    }

    const updated = await tx.customer.update({
      where: { id },
      data: { stage: toStage, lastStageChangeAt: new Date() },
    });

    await this.logActivity(tx, updated.workspaceId, id, {
      kind: CustomerActivityKind.STAGE_CHANGE,
      fromStage: current.stage,
      toStage,
      body:
        note ??
        `${check.direction === 'forward' ? 'Advanced' : 'Moved back'} ${current.stage}→${toStage}`,
      actorUcUid: ucUid,
    });
    return updated;
  }

  async markLostInTx(tx: WorkspaceTxClient, id: string, reason: string, ucUid: string) {
    const current = await this.getInTx(tx, id);
    if (current.isLost) {
      throw new BadRequestException('Relationship is already marked lost');
    }
    const updated = await tx.customer.update({
      where: { id },
      data: { isLost: true, lostReason: reason, closedLostAt: new Date() },
    });
    await this.logActivity(tx, updated.workspaceId, id, {
      kind: CustomerActivityKind.MARKED_LOST,
      body: `Closed-lost: ${reason}`,
      actorUcUid: ucUid,
    });
    return updated;
  }

  async reopenInTx(tx: WorkspaceTxClient, id: string, ucUid: string) {
    const current = await this.getInTx(tx, id);
    if (!current.isLost) {
      throw new BadRequestException('Relationship is not marked lost');
    }
    const updated = await tx.customer.update({
      where: { id },
      data: { isLost: false, lostReason: null, closedLostAt: null },
    });
    await this.logActivity(tx, updated.workspaceId, id, {
      kind: CustomerActivityKind.REOPENED,
      body: 'Re-opened',
      actorUcUid: ucUid,
    });
    return updated;
  }

  async addNoteInTx(tx: WorkspaceTxClient, id: string, body: string, ucUid: string) {
    const current = await this.getInTx(tx, id);
    return this.logActivity(tx, current.workspaceId, id, {
      kind: CustomerActivityKind.NOTE,
      body,
      actorUcUid: ucUid,
    });
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

  /** The workspace id the current RLS transaction is bound to (GUC read). */
  private async boundWorkspaceId(tx: WorkspaceTxClient): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ ws: string | null }>>`
      SELECT current_workspace_id() AS ws
    `;
    const ws = rows?.[0]?.ws;
    if (!ws) {
      // Should be impossible (withWorkspace set the GUC), but fail closed.
      throw new BadRequestException('No workspace bound to the request transaction');
    }
    return ws;
  }

  private async logActivity(
    tx: WorkspaceTxClient,
    workspaceId: string,
    customerId: string,
    data: {
      kind: CustomerActivityKind;
      fromStage?: RelationshipStage;
      toStage?: RelationshipStage;
      body?: string;
      actorUcUid?: string;
    },
  ) {
    return tx.customerActivity.create({
      data: {
        workspaceId,
        customerId,
        kind: data.kind,
        fromStage: data.fromStage,
        toStage: data.toStage,
        body: data.body,
        actorUcUid: data.actorUcUid || null,
      },
    });
  }

  /** Build the federation identity for the user's resolved workspace. */
  private async federationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<FederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return { workspaceId, ucUid: ucUidOf(user) || null };
  }

  /**
   * Join relationship rows with their federated contact summaries (one batched
   * federation call). When `withContacts` is false, or CO is dormant, `contact`
   * is null and the cockpit renders a placeholder — the relationship is the
   * source of truth, the contact is an enrichment.
   */
  private async joinContacts(
    fedCtx: FederationContext,
    rows: Array<Record<string, any>>,
    withContacts: boolean,
  ): Promise<CustomerWithContact[]> {
    let summaries = new Map<
      string,
      {
        displayName: string;
        primaryEmail: string | null;
        currentOrgName: string | null;
        tags: string[];
      }
    >();
    if (withContacts && rows.length > 0) {
      const ids = rows.map((r) => r.contactId);
      const fed = await this.contactOps.getContactSummaries(fedCtx, ids);
      summaries = new Map(
        [...fed.entries()].map(([id, s]) => [
          id,
          {
            displayName: s.displayName,
            primaryEmail: s.primaryEmail,
            currentOrgName: s.currentOrgName,
            tags: s.tags,
          },
        ]),
      );
    }

    return rows.map((r) => ({
      ...this.serialize(r),
      contact: summaries.get(r.contactId) ?? null,
    }));
  }

  /** Serialize a Customer row to the wire shape (Decimal → string). */
  private serialize(row: Record<string, any>): Omit<CustomerWithContact, 'contact'> {
    return {
      id: row.id,
      contactId: row.contactId,
      stage: row.stage,
      priority: row.priority,
      source: row.source ?? null,
      notes: row.notes ?? null,
      ownerUserKey: row.ownerUserKey ?? null,
      expectedValue:
        row.expectedValue !== null && row.expectedValue !== undefined
          ? row.expectedValue.toString()
          : null,
      currency: row.currency ?? null,
      nextActionAt: row.nextActionAt ?? null,
      isLost: !!row.isLost,
      lostReason: row.lostReason ?? null,
      closedLostAt: row.closedLostAt ?? null,
      lastStageChangeAt: row.lastStageChangeAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
