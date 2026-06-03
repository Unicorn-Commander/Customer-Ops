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
 *     FEDERATED contact (ContactOpsPort.getContact) and leaves explicit slots
 *     for the Phase-3 federations (invoices/meetings/email) — never copying the
 *     contact.
 *
 * The methods that mutate or read relationship state accept a transaction
 * client (`tx`) so the orchestration (workspace resolution + GUC) is decoupled
 * from the relationship logic and the logic is unit-testable with a fake tx.
 * The public entry points (`*ForUser`) wrap them in the workspace transaction.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CustomerActivityKind, Prisma, RelationshipStage, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, ucUidOf } from '../common/workspace/workspace.util';
import { ContactOpsPort, FederationContext } from '../contact-ops/contact-ops.port';
import { checkTransition, STAGE_ORDER } from './funnel';
import {
  AddNoteDto,
  CreateCustomerDto,
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
   * contact, with explicit Phase-3 slots (invoices/meetings/email) left empty.
   */
  async customer360ForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    requestedWorkspaceId?: string | null,
  ) {
    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    const { relationship, activities } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const relationship = await this.getInTx(tx, id);
        const activities = await tx.customerActivity.findMany({
          where: { customerId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
        return { relationship, activities };
      },
      requestedWorkspaceId,
    );

    // Federate the contact detail (read-time; never persisted).
    const contact = await this.contactOps.getContact(fedCtx, relationship.contactId);

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
      // ── Phase-3 federation slots (intentionally empty; seams only) ──
      // Accounting-Ops: this customer's invoices/AR (create_invoice_from_draft +
      // get_invoice poll). Meeting-Ops: meetings/action-items. Email-Ops:
      // Stalwart threads. Outreach: campaign membership. Wired in Phase 3.
      invoices: { federated: false, source: 'accounting-ops', items: [] as unknown[] },
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
