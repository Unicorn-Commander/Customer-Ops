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
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditAction, CustomerActivityKind, Prisma, RelationshipStage, User } from '@prisma/client';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { WorkspaceTxClient } from '../prisma/prisma.service';
import { WithWorkspaceClaim, ucUidOf } from '../common/workspace/workspace.util';
import { AuditService } from '../audit/audit.service';
import { ContactOpsPort, FederationContext } from '../contact-ops/contact-ops.port';
import { FederatedContact } from '../contact-ops/contact-ops.types';
import {
  ConversationsOpsPort,
  FederationContext as ConversationsFederationContext,
} from '../conversations-ops/conversations-ops.port';
import {
  ConversationMessage,
  ConversationThread,
} from '../conversations-ops/conversations-ops.types';
import {
  AccountingOpsPort,
  FederationContext as InvoiceFederationContext,
} from '../accounting-ops/accounting-ops.port';
import { FederatedInvoice, InvoiceDraft } from '../accounting-ops/accounting-ops.types';
import {
  OutreachPort,
  FederationContext as OutreachFederationContext,
} from '../outreach-ops/outreach-ops.port';
import {
  OutreachEnrollmentResult,
  OutreachEngagementKind,
} from '../outreach-ops/outreach-ops.types';
import {
  EmailOpsPort,
  FederationContext as EmailFederationContext,
} from '../email-ops/email-ops.port';
import { EmailComposeResult } from '../email-ops/email-ops.types';
import {
  MeetingOpsPort,
  FederationContext as MeetingFederationContext,
} from '../meeting-ops/meeting-ops.port';
import {
  FederatedActionItem,
  FederatedMeeting,
  FederatedMeetingSummary,
} from '../meeting-ops/meeting-ops.types';
import {
  ProjectOpsPort,
  ProjectLookup,
  FederationContext as ProjectFederationContext,
} from '../project-ops/project-ops.port';
import { ProjectPanel } from '../project-ops/project-ops.types';
import { LeadLabelResolver, isProvisionalContactId } from '../lead-intake/lead-label.port';
import { GraphIngestService } from '../graph/graph-ingest.service';
import { mapWithConcurrency } from '../common/concurrency';
import { checkTransition, engagementAdvance, STAGE_ORDER } from './funnel';
import {
  AddNoteDto,
  CreateCustomerDto,
  CreateInvoiceDto,
  ListCustomersQueryDto,
  MarkLostDto,
  RecordEngagementDto,
  ScheduleSocialTouchDto,
  SendEmailDto,
  SendMessageDto,
  StartCampaignDto,
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

/** A federated Outreach touch as the customer-360 renders it (Phase 4). */
export interface OutreachTouchView {
  id: string;
  channel: string;
  campaignId: string | null;
  campaignName: string | null;
  status: string;
  subject: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  lastEngagementKind: OutreachEngagementKind | null;
  lastEngagementAt: string | null;
}

/** A federated Email-Ops thread as the customer-360 renders it (Phase 4). */
export interface EmailThreadView {
  id: string;
  subject: string | null;
  messageCount: number;
  unread: boolean;
  lastMessageAt: string | null;
  lastSnippet: string | null;
  participants: Array<{ address: string; name: string | null }>;
}

/** The federated Meeting-Ops panel the customer-360 renders (Phase 5). Read-time
 *  only — Meeting-Ops owns these; Customer-Ops holds nothing locally. */
export interface MeetingPanelView {
  federated: boolean;
  source: 'meeting-ops';
  configured: boolean;
  meetings: FederatedMeeting[];
  summaries: FederatedMeetingSummary[];
  actionItems: FederatedActionItem[];
}

/** Default cap on the pipeline-board card count (the hottest, federation-heavy
 *  page). Tunable via PIPELINE_MAX_CARDS. */
const PIPELINE_MAX_CARDS_DEFAULT = 500;

/** Resolve the pipeline-board cap from env, else the default (fail-safe on a
 *  non-positive / unparseable value — never an unbounded board). */
function pipelineMaxCards(): number {
  const raw = process.env.PIPELINE_MAX_CARDS;
  if (raw === undefined || raw.trim() === '') return PIPELINE_MAX_CARDS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : PIPELINE_MAX_CARDS_DEFAULT;
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly workspaces: WorkspaceContextService,
    private readonly contactOps: ContactOpsPort,
    private readonly accountingOps: AccountingOpsPort,
    private readonly outreach: OutreachPort,
    private readonly emailOps: EmailOpsPort,
    private readonly meetingOps: MeetingOpsPort,
    private readonly projectOps: ProjectOpsPort,
    // Phase 6: resolves a real label for a PROVISIONAL contactId ('prov:…') from
    // the lead-intake buffer while Contact-Ops is dormant. @Optional so the
    // relationship layer has no hard dependency on the ingestion module.
    // The omni-channel conversations seam (device messaging via UUDC). @Optional
    // + guarded so customer-360 tests that don't provide it still construct; the
    // real CustomersModule binds it. DORMANT until CONVERSATIONS_OPS_BASE_URL.
    @Optional()
    @Inject(ConversationsOpsPort)
    private readonly conversationsOps?: ConversationsOpsPort,
    @Optional()
    @Inject(LeadLabelResolver)
    private readonly leadLabels?: LeadLabelResolver,
    // Post-commit, fire-and-forget graph refresh (CHANGE 1). @Optional so the
    // relationship layer has no hard dependency on the knowledge-graph module
    // (and the existing spec's positional 7-arg construction still compiles —
    // both trailing params are @Optional).
    @Optional()
    @Inject(GraphIngestService)
    private readonly graphIngest?: GraphIngestService,
    // Phase 7: the append-only audit trail. @Optional so the existing positional
    // spec construction still compiles + the relationship layer keeps no hard
    // dep; every call is `this.audit?.log(...)` (and log() never throws).
    @Optional()
    @Inject(AuditService)
    private readonly audit?: AuditService,
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
    const search = query.search?.trim().toLocaleLowerCase();
    if (search) {
      // Identity remains federated. Scan scoped batches before applying result
      // pagination, so a match beyond the first page is never reported absent.
      const matches: CustomerWithContact[] = [];
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      for (let scanOffset = 0; matches.length < offset + limit; scanOffset += 200) {
        const rows = await this.workspaces.runForUser(
          user,
          (tx) => this.listInTx(tx, { ...query, offset: scanOffset, limit: 200 }),
          requestedWorkspaceId,
        );
        const joined = await this.joinContacts(user, fedCtx, rows, true, requestedWorkspaceId);
        // A missing phonebook result cannot establish that an identity does not
        // match. Surface the unavailable search rather than a false negative.
        if (joined.some((row) => !row.contact)) {
          throw new ServiceUnavailableException(
            'Customer search requires resolved contact summaries; Contact-Ops could not resolve all relationships',
          );
        }
        matches.push(
          ...joined.filter((row) =>
            [
              row.contact?.displayName,
              row.contact?.primaryEmail,
              row.contact?.currentOrgName,
              row.notes,
            ].some((value) => value?.toLocaleLowerCase().includes(search)),
          ),
        );
        if (rows.length < 200) break;
      }
      const items = matches
        .slice(offset, offset + limit)
        .map((row) => (query.withContacts === false ? { ...row, contact: null } : row));
      return { items, count: items.length };
    }
    const rows = await this.workspaces.runForUser(
      user,
      (tx) => this.listInTx(tx, query),
      requestedWorkspaceId,
    );
    const withContacts = query.withContacts ?? true;
    const joined = await this.joinContacts(user, fedCtx, rows, withContacts, requestedWorkspaceId);
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
    const [joined] = await this.joinContacts(user, fedCtx, [row], true, requestedWorkspaceId);
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
    const { relationship, activities, invoiceLinks, outreachLinks, emailLinks } =
      await this.workspaces.runForUser(
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
          // Phase-4 thin links: the outreach enrollments + outbound emails THIS
          // app initiated (RLS-scoped). The live campaign/thread history is
          // FEDERATED from the apps at read time; these are only the de-dupe
          // memory + cached status.
          const outreachLinks = await tx.customerOutreachLink.findMany({
            where: { customerId: id },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });
          const emailLinks = await tx.customerEmailLink.findMany({
            where: { customerId: id },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });
          return { relationship, activities, invoiceLinks, outreachLinks, emailLinks };
        },
        requestedWorkspaceId,
      );

    // Federate the contact detail (read-time; never persisted). Resolved FIRST
    // because the Project-Ops panel matches on the contact's org/name.
    const contact = await this.contactOps.getContact(fedCtx, relationship.contactId);

    // The five federation panels are INDEPENDENT, each internally best-effort +
    // degrade-clean (never throws; returns a degrade affordance on failure) and
    // run OUTSIDE the DB tx. Fan them out concurrently so the 360's latency is
    // max(panel) not sum(panel) — a single slow sibling no longer stacks onto
    // every other. (Each build*Panel already parallelizes its own sub-calls.)
    const [invoices, outreachPanel, emailPanel, meetingPanel, projectPanel, conversationsPanel] =
      await Promise.all([
        // Accounting-Ops: poll each linked invoice's live status; refresh the cache.
        this.buildInvoicePanel(user, invoiceLinks, requestedWorkspaceId),
        // Outreach app: live campaigns/touches + the local enrollment links.
        this.buildOutreachPanel(user, relationship.contactId, outreachLinks, requestedWorkspaceId),
        // Email-Ops: live mailbox threads + the local outbound links.
        this.buildEmailPanel(user, relationship.contactId, emailLinks, requestedWorkspaceId),
        // Meeting-Ops: the customer's meetings + summaries + action items.
        this.buildMeetingPanel(user, relationship.contactId, requestedWorkspaceId),
        // Project-Ops: the delivery work for this account (relationship ids first,
        // then contact org/name).
        this.buildProjectPanel(
          user,
          relationship.id,
          relationship.contactId,
          contact,
          requestedWorkspaceId,
        ),
        // Device messaging (UUDC): the worker's iMessage/SMS with the contact's
        // handles, resolved from the already-federated `contact`.
        this.buildConversationsPanel(user, contact, requestedWorkspaceId),
      ]);

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
      // ── Phase-4: the Outreach + Email-Ops panels (federated, live) ──
      outreach: outreachPanel,
      email: emailPanel,
      // ── Phase-5: the Meeting-Ops panel (federated conversation signal) ──
      meetings: meetingPanel,
      // ── Project-Ops panel (federated delivery / project signal) ──
      projects: projectPanel,
      // ── Omni-channel device conversations panel (UUDC iMessage/SMS) ──
      conversations: conversationsPanel,
    };
  }

  /**
   * Record one relationship-write audit event (Phase 7). The caller passes the
   * ALREADY-resolved workspaceId so the audit row's workspace matches the write's
   * GUC (RLS WITH CHECK). Never throws (AuditService.log swallows failures; `?.`
   * no-ops when the audit module is absent, e.g. in unit tests).
   */
  private async auditWrite(
    workspaceId: string,
    ucUid: string | null | undefined,
    action: AuditAction,
    resource: string,
    resourceId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit?.log({
      workspaceId,
      userId: ucUid ?? undefined,
      action,
      resource,
      resourceId,
      details,
    });
  }

  async createForUser(
    user: User & Partial<WithWorkspaceClaim>,
    dto: CreateCustomerDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const row = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.createInTx(tx, dto, ucUid),
    );
    this.refreshGraph(user, row.id, requestedWorkspaceId);
    await this.auditWrite(workspaceId, ucUid, AuditAction.CREATE, 'customer', row.id, {
      contactId: dto.contactId,
      stage: row.stage,
    });
    return this.serialize(row);
  }

  async updateForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: UpdateCustomerDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const row = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.updateInTx(tx, id, dto, ucUid),
    );
    this.refreshGraph(user, id, requestedWorkspaceId);
    await this.auditWrite(workspaceId, ucUid, AuditAction.UPDATE, 'customer', id, {
      fields: Object.keys(dto ?? {}),
    });
    return this.serialize(row);
  }

  async transitionForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: TransitionStageDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const row = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.transitionInTx(tx, id, dto.toStage, dto.note, ucUid),
    );
    this.refreshGraph(user, id, requestedWorkspaceId);
    await this.auditWrite(workspaceId, ucUid, AuditAction.UPDATE, 'customer', id, {
      kind: 'transition',
      toStage: dto.toStage,
    });
    return this.serialize(row);
  }

  async markLostForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: MarkLostDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const row = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.markLostInTx(tx, id, dto.reason, ucUid),
    );
    this.refreshGraph(user, id, requestedWorkspaceId);
    await this.auditWrite(workspaceId, ucUid, AuditAction.UPDATE, 'customer', id, {
      kind: 'mark_lost',
    });
    return this.serialize(row);
  }

  async reopenForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const row = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.reopenInTx(tx, id, ucUid),
    );
    this.refreshGraph(user, id, requestedWorkspaceId);
    await this.auditWrite(workspaceId, ucUid, AuditAction.UPDATE, 'customer', id, {
      kind: 'reopen',
    });
    return this.serialize(row);
  }

  async addNoteForUser(
    user: User & Partial<WithWorkspaceClaim>,
    id: string,
    dto: AddNoteDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const result = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.addNoteInTx(tx, id, dto.body, ucUid),
    );
    await this.auditWrite(workspaceId, ucUid, AuditAction.CREATE, 'customer_note', id, {
      kind: 'note',
    });
    return result;
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
    // BOUND the board: this is the hottest page and each card can trigger a
    // federated contact resolve. An unbounded findMany on a large workspace would
    // fan out one get_person per row over federation (N+1) — cap to the top
    // `PIPELINE_MAX_CARDS` by priority so the page (and the batched resolve below)
    // stays bounded. `+1` lets us detect + flag truncation. Read-only tx.
    const max = pipelineMaxCards();
    const rows = await this.workspaces.runForUserReadOnly(
      user,
      (tx) =>
        tx.customer.findMany({
          where: { isLost: false },
          orderBy: [{ priority: 'desc' }, { lastStageChangeAt: 'asc' }],
          take: max + 1,
        }),
      requestedWorkspaceId,
    );
    const truncated = rows.length > max;
    if (truncated) {
      rows.length = max;
      this.logger.warn(
        `Pipeline board truncated to ${max} cards (set PIPELINE_MAX_CARDS to raise the cap).`,
      );
    }
    // The batched, bounded-concurrency federation resolve (getContactSummaries
    // caps simultaneous get_person calls) turns N cards into a steady wave, not
    // N simultaneous calls.
    const joined = await this.joinContacts(user, fedCtx, rows, withContacts, requestedWorkspaceId);

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
        // Signals the client that the board was capped (show the top `max` by
        // priority); the operator can raise PIPELINE_MAX_CARDS if they need more.
        truncated,
        max,
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
    return this.buildInvoicePanel(user, links, requestedWorkspaceId, customerId);
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
      entitlements: await this.workspaces.effectiveEntitlements(user, workspaceId),
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
    customerId?: string,
  ) {
    const configured = this.accountingOps.isConfigured();
    const fedCtx = configured
      ? await this.invoiceFederationContext(user, requestedWorkspaceId)
      : null;
    const entitled = fedCtx ? this.accountingOps.checkEntitlement(fedCtx).allowed : false;

    let items = links.map((l) => this.serializeInvoiceLink(l));

    // A denied accounting-ops entitlement does not fetch Accounting-Ops.
    // Cached links still render. When the caller is entitled, pull invoices
    // that Project-Ops already created for this customer and refresh the cache.
    if (configured && fedCtx && entitled && customerId) {
      links = await this.cacheInvoicesForCustomer(
        user,
        fedCtx,
        customerId,
        links,
        requestedWorkspaceId,
      );
    }
    if (configured && fedCtx && entitled && links.length > 0) {
      // 1) Poll every link concurrently — pure federation, no DB tx held open.
      const polled = await Promise.all(
        links.map(async (l) => ({ link: l, invoice: await this.pollInvoice(fedCtx, l) })),
      );
      // 2) Persist all refreshed projections in ONE workspace tx (was one tx per
      //    link — up to 100 transactions on a many-invoice 360). Best-effort: a
      //    batch write failure degrades to the freshly-polled values for render.
      const toWrite = polled.filter((p) => p.invoice);
      let updatedById = new Map<string, Record<string, any>>();
      if (toWrite.length > 0) {
        try {
          updatedById = await this.workspaces.runForUser(
            user,
            async (tx) => {
              const m = new Map<string, Record<string, any>>();
              for (const { link, invoice } of toWrite) {
                const u = await tx.customerInvoiceLink.update({
                  where: { id: link.id },
                  data: this.invoiceCacheUpdate(invoice!),
                });
                m.set(link.id, u as Record<string, any>);
              }
              return m;
            },
            requestedWorkspaceId,
          );
        } catch (err) {
          this.logger.warn(`AO invoice cache batch refresh failed: ${(err as Error).message}`);
        }
      }
      // 3) Render: the refreshed row where the write landed, the polled overlay
      //    where it didn't, and last-cached where the poll itself failed.
      items = polled.map(({ link, invoice }) => {
        const updated = updatedById.get(link.id);
        if (updated) return this.serializeInvoiceLink(updated);
        if (invoice)
          return { ...this.serializeInvoiceLink(link), ...this.invoiceProjection(invoice) };
        return this.serializeInvoiceLink(link);
      });
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
   * Poll one link via AO get_invoice (by AO id if known, else by (source, ref)).
   * Pure read — no DB write (the caller batches the cache refresh into a single
   * workspace tx). Best-effort: returns null on a poll failure (last-cached).
   */
  private async pollInvoice(
    fedCtx: InvoiceFederationContext,
    link: Record<string, any>,
  ): Promise<FederatedInvoice | null> {
    try {
      return link.aoInvoiceId
        ? await this.accountingOps.getInvoiceById(fedCtx, link.aoInvoiceId)
        : await this.accountingOps.getInvoiceByRef(fedCtx, link.externalSource, link.externalRef);
    } catch (err) {
      this.logger.warn(`AO poll failed for link ${link.id}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Upsert Accounting-Ops invoices for this customer into the local link cache. */
  private async cacheInvoicesForCustomer(
    user: User & Partial<WithWorkspaceClaim>,
    fedCtx: InvoiceFederationContext,
    customerId: string,
    links: Array<Record<string, any>>,
    requestedWorkspaceId?: string | null,
  ): Promise<Array<Record<string, any>>> {
    const list = this.accountingOps.listInvoicesForCustomer;
    if (!list) return links;
    let found: FederatedInvoice[] = [];
    try {
      found = await list.call(this.accountingOps, fedCtx, customerId);
    } catch (err) {
      this.logger.warn(`AO invoice list failed: ${(err as Error).message}`);
      return links;
    }
    const fresh = found.filter(
      (invoice) => invoice.externalSource && invoice.externalRef && invoice.entityId,
    );
    if (fresh.length === 0) return links;
    try {
      const rows = await this.workspaces.runForUser(
        user,
        async (tx) => {
          const workspaceId = await this.boundWorkspaceId(tx);
          const written: Array<Record<string, any>> = [];
          for (const invoice of fresh) {
            const externalSource = invoice.externalSource ?? '';
            const externalRef = invoice.externalRef ?? '';
            const entityId = invoice.entityId ?? '';
            const row = await tx.customerInvoiceLink.upsert({
              where: {
                workspaceId_externalSource_externalRef: {
                  workspaceId,
                  externalSource,
                  externalRef,
                },
              },
              create: {
                workspaceId,
                customerId,
                externalSource,
                externalRef,
                entityId,
                aoInvoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                lastStatus: invoice.status,
                currency: invoice.currency || 'USD',
                totalAmount: invoice.total != null ? new Prisma.Decimal(invoice.total) : null,
                lastBalanceDue:
                  invoice.balanceDue != null ? new Prisma.Decimal(invoice.balanceDue) : null,
                lastPolledAt: new Date(),
              },
              update: this.invoiceCacheUpdate(invoice),
            });
            written.push(row as Record<string, any>);
          }
          return written;
        },
        requestedWorkspaceId,
      );
      const byKey = new Map(
        links.map((link) => [`${link.externalSource}:${link.externalRef}`, link]),
      );
      for (const row of rows) byKey.set(`${row.externalSource}:${row.externalRef}`, row);
      return [...byKey.values()];
    } catch (err) {
      this.logger.warn(`AO invoice link cache failed: ${(err as Error).message}`);
      return links;
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

  // ========================================================================
  // SYSTEM INVOICE REFRESH — the scheduler's per-workspace cache refresh. Polls
  // every linked invoice's live AO status and refreshes the cached projection,
  // so an operator opening a 360 sees a fresh status even when nobody triggered
  // a poll. Reads are viewer-level on AO (no dual-SKU needed), so the system
  // actor (ucUid=null, no entitlements) can poll. Federation runs OUTSIDE the tx;
  // the workspace is bound explicitly via runInWorkspace (RLS GUC). Best-effort.
  // ========================================================================

  /**
   * Refresh the cached AO status of every invoice link in ONE workspace. No-op
   * when AO is unconfigured. Returns a small counter for the scheduler log.
   */
  async refreshInvoiceCachesSystem(
    workspaceId: string,
    limit = 500,
  ): Promise<{ polled: number; refreshed: number }> {
    if (!this.accountingOps.isConfigured()) return { polled: 0, refreshed: 0 };

    // 1) Read the links to poll (system-actor RLS tx).
    const links = await this.workspaces.runInWorkspace(workspaceId, null, (tx) =>
      tx.customerInvoiceLink.findMany({ orderBy: { lastPolledAt: 'asc' }, take: limit }),
    );
    if (links.length === 0) return { polled: 0, refreshed: 0 };

    // 2) Poll with BOUNDED concurrency — a busy workspace can hold many links, and
    //    an unbounded Promise.all would fire them all at AO at once. Pure
    //    federation, no DB tx held open across the network calls.
    const fedCtx: InvoiceFederationContext = { workspaceId, ucUid: null, entitlements: [] };
    const INVOICE_POLL_CONCURRENCY = 8;
    const polled = await mapWithConcurrency(links, INVOICE_POLL_CONCURRENCY, async (link) => ({
      link,
      invoice: await this.pollInvoice(fedCtx, link as Record<string, any>),
    }));

    // 3) Persist refreshed projections in ONE workspace tx.
    const toWrite = polled.filter((p) => p.invoice);
    if (toWrite.length === 0) return { polled: links.length, refreshed: 0 };
    try {
      await this.workspaces.runInWorkspace(workspaceId, null, async (tx) => {
        for (const { link, invoice } of toWrite) {
          await tx.customerInvoiceLink.update({
            where: { id: (link as Record<string, any>).id },
            data: this.invoiceCacheUpdate(invoice!),
          });
        }
      });
    } catch (err) {
      this.logger.warn(
        `System invoice cache refresh write failed for ${workspaceId}: ${(err as Error).message}`,
      );
      return { polled: links.length, refreshed: 0 };
    }
    return { polled: links.length, refreshed: toWrite.length };
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
  // PHASE 4 — OUTREACH SURFACE (the Outreach app federation seam).
  //
  // Customer-Ops FEDERATES outreach: the (future) Outreach app is the campaign
  // engine-surface (Listmonk + Postiz) + the system-of-record for every
  // campaign/send/touch. These entry points (a) read the live campaigns/touches
  // for the contact + the local enrollment links, and (b) TRIGGER a campaign
  // enrollment / social touch (idempotent on (workspace, source, ref)), keeping
  // only a thin local CustomerOutreachLink. They NEVER send a campaign or store
  // a recipient list. Triggers are dual-SKU gated (customer-ops + outreach);
  // reads are viewer-level.
  // ========================================================================

  /**
   * The customer's outreach panel: the live campaigns/touches federated from the
   * Outreach app joined with the local enrollment links. Degrade-clean +
   * entitlement affordances, identical shape/contract to the invoice panel.
   */
  async outreachForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ) {
    const { contactId, links } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const rel = await this.getInTx(tx, customerId);
        const links = await tx.customerOutreachLink.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        return { contactId: rel.contactId, links };
      },
      requestedWorkspaceId,
    );
    return this.buildOutreachPanel(user, contactId, links, requestedWorkspaceId);
  }

  /**
   * Start a campaign/sequence for this customer: enroll the federated contact in
   * the Outreach app + record a thin local link. Gated on BOTH customer-ops AND
   * outreach (UC_ENTITLEMENT_MODE=open bypasses with a WARN); 403 when not
   * entitled, 400 when Outreach is unconfigured (degrade-clean), 502 when
   * reachable but the call fails. Idempotent on the deterministic external_ref.
   */
  async startCampaignForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    dto: StartCampaignDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const fedCtx = await this.outreachFederationContext(user, requestedWorkspaceId);

    if (!this.outreach.isConfigured()) {
      throw new BadRequestException(
        'Outreach is not connected for this deployment. Set OUTREACH_BASE_URL to ' +
          'enable campaigns. (Customer-Ops federates outreach to the Outreach app; ' +
          'it is not a campaign engine.)',
      );
    }
    const gate = this.outreach.checkEntitlement(fedCtx);
    if (!gate.allowed) {
      this.logger.warn(
        `Campaign start denied for ${ucUid} (ws=${fedCtx.workspaceId}): ${gate.reason}`,
      );
      throw new ForbiddenException(gate.reason);
    }

    const idemKey = dto.idempotencyKey?.trim() || randomUUID();
    const externalSource = 'customer-ops';
    const externalRef = `cust:${customerId}:enroll:${idemKey}`;

    // 1) Resolve the relationship + record/locate the link FIRST so the (source,
    //    ref) survives even if the Outreach call fails mid-flight (idempotent retry).
    const { link, contactId } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const rel = await this.getInTx(tx, customerId);
        const workspaceId = await this.boundWorkspaceId(tx);
        const existing = await tx.customerOutreachLink.findUnique({
          where: {
            workspaceId_externalSource_externalRef: { workspaceId, externalSource, externalRef },
          },
        });
        if (existing) return { link: existing, contactId: rel.contactId };
        const created = await tx.customerOutreachLink.create({
          data: {
            workspaceId,
            customerId,
            contactId: rel.contactId,
            channel: 'email',
            externalSource,
            externalRef,
            campaignId: dto.campaignId,
            createdByUcUid: ucUid || null,
          },
        });
        return { link: created, contactId: rel.contactId };
      },
      requestedWorkspaceId,
    );

    // 2) Call the Outreach app (idempotent on the tuple). Outside the DB tx.
    const result = await this.outreach.enrollContact(fedCtx, {
      campaignId: dto.campaignId,
      contactId,
      contactEmail: dto.contactEmail ?? null,
      externalSource,
      externalRef,
      mergeFields: dto.mergeFields ?? null,
    });
    if (!result) {
      throw new ServiceUnavailableException(
        'Outreach did not return an enrollment. The link is recorded; retry to ' +
          'complete it (the enrollment is idempotent on the same reference).',
      );
    }

    // 3) Refresh the link's cached projection + log the relationship activity.
    const refreshed = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const updated = await tx.customerOutreachLink.update({
          where: { id: link.id },
          data: this.outreachCacheUpdate(result),
        });
        await this.logActivity(tx, updated.workspaceId, customerId, {
          kind: CustomerActivityKind.CAMPAIGN_STARTED,
          body:
            `Enrolled in Outreach campaign ${result.campaignName ?? result.campaignId ?? dto.campaignId} ` +
            `(${result.status}) · ref ${externalRef}`,
          actorUcUid: ucUid,
        });
        return updated;
      },
      requestedWorkspaceId,
    );

    return { link: this.serializeOutreachLink(refreshed), enrollment: result };
  }

  /**
   * Schedule a single social touch (Postiz) for this customer's contact + record
   * a thin link. Same gating/idempotency/degrade-clean as startCampaign.
   */
  async scheduleSocialTouchForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    dto: ScheduleSocialTouchDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const fedCtx = await this.outreachFederationContext(user, requestedWorkspaceId);

    if (!this.outreach.isConfigured()) {
      throw new BadRequestException(
        'Outreach is not connected for this deployment. Set OUTREACH_BASE_URL to ' +
          'enable social touches.',
      );
    }
    const gate = this.outreach.checkEntitlement(fedCtx);
    if (!gate.allowed) {
      this.logger.warn(
        `Social touch denied for ${ucUid} (ws=${fedCtx.workspaceId}): ${gate.reason}`,
      );
      throw new ForbiddenException(gate.reason);
    }

    const idemKey = dto.idempotencyKey?.trim() || randomUUID();
    const externalSource = 'customer-ops';
    const externalRef = `cust:${customerId}:social:${idemKey}`;

    const { link, contactId } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const rel = await this.getInTx(tx, customerId);
        const workspaceId = await this.boundWorkspaceId(tx);
        const existing = await tx.customerOutreachLink.findUnique({
          where: {
            workspaceId_externalSource_externalRef: { workspaceId, externalSource, externalRef },
          },
        });
        if (existing) return { link: existing, contactId: rel.contactId };
        const created = await tx.customerOutreachLink.create({
          data: {
            workspaceId,
            customerId,
            contactId: rel.contactId,
            channel: 'social',
            externalSource,
            externalRef,
            campaignId: dto.channelId,
            createdByUcUid: ucUid || null,
          },
        });
        return { link: created, contactId: rel.contactId };
      },
      requestedWorkspaceId,
    );

    const result = await this.outreach.scheduleSocialTouch(fedCtx, {
      channelId: dto.channelId,
      contactId,
      body: dto.body,
      scheduledAt: dto.scheduledAt ?? null,
      externalSource,
      externalRef,
    });
    if (!result) {
      throw new ServiceUnavailableException(
        'Outreach did not return a scheduled touch. The link is recorded; retry ' +
          'to complete it (idempotent on the same reference).',
      );
    }

    const refreshed = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const updated = await tx.customerOutreachLink.update({
          where: { id: link.id },
          data: this.outreachCacheUpdate(result),
        });
        await this.logActivity(tx, updated.workspaceId, customerId, {
          kind: CustomerActivityKind.CAMPAIGN_STARTED,
          body: `Scheduled a social touch (${result.status}) · ref ${externalRef}`,
          actorUcUid: ucUid,
        });
        return updated;
      },
      requestedWorkspaceId,
    );

    return { link: this.serializeOutreachLink(refreshed), enrollment: result };
  }

  // ========================================================================
  // PHASE 4 — EMAIL SURFACE (the Email-Ops app federation seam).
  //
  // Customer-Ops FEDERATES mailboxes: the (future) Email-Ops app is the mailbox
  // surface (Stalwart) + the system-of-record for every thread/message. These
  // entry points (a) read the live threads with the contact + the local outbound
  // links, and (b) SEND/DRAFT one outbound email (idempotent), keeping only a
  // thin local CustomerEmailLink. They NEVER store a message body. Sends/drafts
  // are dual-SKU gated (customer-ops + email-ops); reads are viewer-level.
  // ========================================================================

  /**
   * The customer's email panel: the live mailbox threads federated from the
   * Email-Ops app joined with the local outbound links. Degrade-clean +
   * entitlement affordances, identical shape/contract to the invoice panel.
   */
  async emailForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ) {
    const { contactId, links } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const rel = await this.getInTx(tx, customerId);
        const links = await tx.customerEmailLink.findMany({
          where: { customerId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        return { contactId: rel.contactId, links };
      },
      requestedWorkspaceId,
    );
    return this.buildEmailPanel(user, contactId, links, requestedWorkspaceId);
  }

  /**
   * Send or draft an outbound email to this customer's contact via the Email-Ops
   * app + record a thin local link. Gated on BOTH customer-ops AND email-ops
   * (open bypasses with a WARN); 403 not entitled, 400 unconfigured
   * (degrade-clean), 502 when reachable but the call fails. Idempotent on the
   * deterministic external_ref. `mode:'send'` queues delivery; `mode:'draft'`
   * stages the agent-inbox approval surface.
   */
  async sendEmailForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    dto: SendEmailDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const fedCtx = await this.emailFederationContext(user, requestedWorkspaceId);
    const mode = dto.mode ?? 'draft';

    if (!this.emailOps.isConfigured()) {
      throw new BadRequestException(
        'Email-Ops is not connected for this deployment. Set EMAIL_OPS_BASE_URL to ' +
          'enable email. (Customer-Ops federates mailboxes to the Email-Ops app; it ' +
          'is not a mail server.)',
      );
    }
    const gate = this.emailOps.checkEntitlement(fedCtx);
    if (!gate.allowed) {
      this.logger.warn(
        `Email ${mode} denied for ${ucUid} (ws=${fedCtx.workspaceId}): ${gate.reason}`,
      );
      throw new ForbiddenException(gate.reason);
    }

    // Runtime kill switch (workspace-scoped): halt outbound SENDS at dispatch
    // when this workspace is paused. Drafts stay allowed — they only stage the
    // agent-inbox approval surface (a human approves before anything leaves).
    if (mode === 'send') {
      await this.workspaces.assertAgentsNotPaused(fedCtx.workspaceId);
    }

    // Resolve the recipient: the explicit override, else the federated contact's
    // primary email (federate, don't store). 400 when neither is available.
    let toAddress = dto.toAddress?.trim() || null;
    let contactId: string | null = null;
    if (!toAddress) {
      // Pre-read the relationship's contactId (RLS-scoped), then federate the
      // address from Contact-Ops (best-effort).
      contactId = await this.workspaces.runForUser(
        user,
        async (tx) => (await this.getInTx(tx, customerId)).contactId,
        requestedWorkspaceId,
      );
      const contactCtx = await this.federationContext(user, requestedWorkspaceId);
      const contact = await this.contactOps.getContact(contactCtx, contactId);
      toAddress = contact?.primaryEmail ?? null;
    }
    if (!toAddress) {
      throw new BadRequestException(
        'No recipient address: pass toAddress, or ensure the federated contact has ' +
          'a primary email (Contact-Ops). Customer-Ops does not store the address.',
      );
    }

    const idemKey = dto.idempotencyKey?.trim() || randomUUID();
    const externalSource = 'customer-ops';
    const externalRef = `cust:${customerId}:email:${idemKey}`;

    const { link, resolvedContactId } = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const rel = await this.getInTx(tx, customerId);
        const workspaceId = await this.boundWorkspaceId(tx);
        const existing = await tx.customerEmailLink.findUnique({
          where: {
            workspaceId_externalSource_externalRef: { workspaceId, externalSource, externalRef },
          },
        });
        if (existing) return { link: existing, resolvedContactId: rel.contactId };
        const created = await tx.customerEmailLink.create({
          data: {
            workspaceId,
            customerId,
            contactId: rel.contactId,
            mode,
            externalSource,
            externalRef,
            threadId: dto.inReplyToThreadId ?? null,
            subject: dto.subject,
            createdByUcUid: ucUid || null,
          },
        });
        return { link: created, resolvedContactId: rel.contactId };
      },
      requestedWorkspaceId,
    );

    const result = await this.emailOps.composeEmail(fedCtx, {
      contactId: resolvedContactId,
      toAddress,
      fromAddress: dto.fromAddress?.trim() || null,
      subject: dto.subject,
      body: dto.body,
      inReplyToThreadId: dto.inReplyToThreadId ?? null,
      mode,
      externalSource,
      externalRef,
    });
    if (!result) {
      throw new ServiceUnavailableException(
        'Email-Ops did not return a message. The link is recorded; retry to ' +
          'complete it (idempotent on the same reference).',
      );
    }

    const refreshed = await this.workspaces.runForUser(
      user,
      async (tx) => {
        const updated = await tx.customerEmailLink.update({
          where: { id: link.id },
          data: this.emailCacheUpdate(result),
        });
        await this.logActivity(tx, updated.workspaceId, customerId, {
          kind: CustomerActivityKind.EMAIL_SENT,
          body:
            `Email "${dto.subject}" ${mode === 'draft' ? 'drafted for approval' : 'sent'} ` +
            `via Email-Ops (${result.status}) · ref ${externalRef}`,
          actorUcUid: ucUid,
        });
        return updated;
      },
      requestedWorkspaceId,
    );

    return { link: this.serializeEmailLink(refreshed), message: result };
  }

  // ========================================================================
  // PHASE 4 — the ENGAGEMENT → FUNNEL-STAGE hook.
  //
  // An inbound engagement signal (a reply/click from Outreach or Email-Ops; a
  // bounce) advances the customer's funnel stage when positive, in ONE RLS tx,
  // with an append-only activity row recording WHY. This is the reply/bounce →
  // stage-change hook the brief requires: an endpoint/service method that drives
  // the funnel on engagement, with activity logging. It NEVER skips qualification
  // (it advances exactly one funnel step, the same guardrail as a manual
  // transition) and never advances a lost/converted/end-of-funnel relationship.
  // ========================================================================

  /**
   * Record an engagement on a customer and advance the funnel stage if the signal
   * warrants it. Returns the (possibly unchanged) relationship + whether an
   * advance happened + the reason. Positive signals (replied/clicked) advance one
   * step; opened is logged but does not advance by default; bounced/unsubscribed
   * never advance (they are recorded as engagement provenance only).
   */
  async recordEngagementForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    dto: RecordEngagementDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    const result = await this.workspaces.runInWorkspace(workspaceId, ucUid, (tx) =>
      this.recordEngagementInTx(tx, customerId, dto, ucUid),
    );
    // An engagement can advance the funnel stage — the same state change that
    // /transition audits. Record it so the audit trail is consistent across both
    // entry points (this was the one relationship write with no audit row).
    const toStage = 'toStage' in result ? result.toStage : undefined;
    await this.auditWrite(workspaceId, ucUid, AuditAction.UPDATE, 'customer', customerId, {
      kind: 'engagement',
      signal: dto.kind,
      advanced: result.advanced,
      ...(toStage ? { toStage } : {}),
    });
    return result;
  }

  /**
   * The engagement→stage logic (tx-scoped; unit-testable with a fake tx). Decides
   * whether the signal advances the funnel (pure policy in `engagementAdvance`),
   * applies the stage change + stamps lastStageChangeAt, and writes BOTH the
   * canonical STAGE_CHANGE activity (with from/to) AND an ENGAGEMENT_ADVANCED row
   * tagging the provenance — all in the SAME tx so the timeline never drifts.
   * When the signal does not advance (opened / bounced / already at the top /
   * lost), it still records the engagement as an activity (no stage write).
   */
  async recordEngagementInTx(
    tx: WorkspaceTxClient,
    customerId: string,
    dto: RecordEngagementDto,
    ucUid: string,
  ) {
    const current = await this.getInTx(tx, customerId);
    const sourceLabel = dto.source ?? 'outreach';
    const detail = dto.detail ? ` — ${dto.detail}` : '';
    const decision = engagementAdvance(current.stage, dto.kind, current.isLost);

    if (!decision.advance || !decision.toStage) {
      // No advance: record the engagement as provenance only (a NOTE-grade row
      // tagged ENGAGEMENT_ADVANCED with advance=false in the body for clarity).
      await this.logActivity(tx, current.workspaceId, customerId, {
        kind: CustomerActivityKind.ENGAGEMENT_ADVANCED,
        body: `Engagement '${dto.kind}' from ${sourceLabel}${detail} — ${decision.reason}`,
        actorUcUid: ucUid,
      });
      return {
        relationship: this.serialize(current),
        advanced: false,
        reason: decision.reason,
      };
    }

    // Advance exactly one funnel step (the funnel guardrail still applies).
    const updated = await tx.customer.update({
      where: { id: customerId },
      data: { stage: decision.toStage, lastStageChangeAt: new Date() },
    });

    // Canonical stage-change row (from/to) so reporting/age logic is uniform…
    await this.logActivity(tx, updated.workspaceId, customerId, {
      kind: CustomerActivityKind.STAGE_CHANGE,
      fromStage: current.stage,
      toStage: decision.toStage,
      body: `Advanced ${current.stage}→${decision.toStage} on '${dto.kind}' engagement (${sourceLabel})`,
      actorUcUid: ucUid,
    });
    // …plus the engagement provenance row tagging WHY it advanced.
    await this.logActivity(tx, updated.workspaceId, customerId, {
      kind: CustomerActivityKind.ENGAGEMENT_ADVANCED,
      fromStage: current.stage,
      toStage: decision.toStage,
      body: `Engagement '${dto.kind}' from ${sourceLabel}${detail} advanced the funnel`,
      actorUcUid: ucUid,
    });

    return {
      relationship: this.serialize(updated),
      advanced: true,
      fromStage: current.stage,
      toStage: decision.toStage,
      reason: decision.reason,
    };
  }

  // ========================================================================
  // PHASE 5 — MEETING SIGNAL (the Meeting-Ops app federation seam).
  //
  // Customer-Ops FEDERATES conversation signal: Meeting-Ops is the
  // system-of-record for every meeting/transcript/summary/action item. This
  // entry point reads the customer's meetings + summaries + action items for the
  // federated contact, PURELY at read time — there is NO local Meeting-Ops table
  // and no write path. It fills the customer-360 meeting slot (federated, never
  // copied) and is what the relationship agents consume as signal. Reads are
  // viewer-level (no dual-SKU); the metered lane in this phase is agent inference.
  // ========================================================================

  /**
   * The customer's meeting panel: meetings + summaries + action items federated
   * from Meeting-Ops. Degrade-clean: when Meeting-Ops is unconfigured the panel
   * reports `configured:false` ("connect Meeting-Ops") and no call is made.
   */
  async meetingsForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ) {
    const contactId = await this.workspaces.runForUser(
      user,
      async (tx) => (await this.getInTx(tx, customerId)).contactId,
      requestedWorkspaceId,
    );
    return this.buildMeetingPanel(user, contactId, requestedWorkspaceId);
  }

  /** Build the Meeting-Ops federation identity (workspace + actor; no entitlements
   *  — meeting reads are viewer-level conversation signal). */
  private async meetingFederationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<MeetingFederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return { workspaceId, ucUid: ucUidOf(user) || null };
  }

  /**
   * Assemble the customer-360 meeting panel: the contact's meetings + summaries +
   * action items, federated from Meeting-Ops. Never throws (best-effort);
   * degrade-clean when Meeting-Ops is unconfigured. Reads are viewer-level, so
   * there is no entitlement affordance — just `configured`. Federated, never
   * copied; Customer-Ops persists nothing here.
   */
  private async buildMeetingPanel(
    user: User & Partial<WithWorkspaceClaim>,
    contactId: string,
    requestedWorkspaceId?: string | null,
  ): Promise<MeetingPanelView> {
    const configured = this.meetingOps.isConfigured();
    const base: MeetingPanelView = {
      federated: configured,
      source: 'meeting-ops',
      configured,
      meetings: [],
      summaries: [],
      actionItems: [],
    };
    if (!configured) return base;

    const fedCtx = await this.meetingFederationContext(user, requestedWorkspaceId);
    try {
      const [page, summaries, actionItems] = await Promise.all([
        this.meetingOps.listMeetingsForContact(fedCtx, contactId, { limit: 25 }),
        this.meetingOps.listSummariesForContact(fedCtx, contactId, { limit: 10 }),
        this.meetingOps.listActionItemsForContact(fedCtx, contactId, { limit: 50 }),
      ]);
      base.meetings = page.items;
      base.summaries = summaries;
      base.actionItems = actionItems;
    } catch (err) {
      this.logger.warn(`Meeting panel federation failed: ${(err as Error).message}`);
    }
    return base;
  }

  // ---- Project-Ops federation (delivery / projects panel) ----------------

  /** The standalone customer-360 projects slot: GET /customers/:id/projects. */
  async projectsForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ): Promise<ProjectPanel> {
    if (!this.projectOps.isConfigured()) {
      return { federated: false, source: 'project-ops', configured: false, projects: [] };
    }
    const fedCtx = await this.federationContext(user, requestedWorkspaceId);
    const contactId = await this.workspaces.runForUser(
      user,
      async (tx) => (await this.getInTx(tx, customerId)).contactId,
      requestedWorkspaceId,
    );
    const contact = await this.contactOps.getContact(fedCtx, contactId);
    return this.buildProjectPanel(user, customerId, contactId, contact, requestedWorkspaceId);
  }

  /** Build the Project-Ops federation identity (workspace + actor; entitlements
   *  carried for parity — project reads are viewer-level). */
  private async projectFederationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<ProjectFederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return {
      workspaceId,
      ucUid: ucUidOf(user) || null,
      entitlements: await this.workspaces.effectiveEntitlements(user, workspaceId),
    };
  }

  /**
   * Assemble the customer-360 projects panel: the projects Project-Ops is
   * delivering for this account, matched by relationship ids first and the
   * customer's federated org / contact name second. Never throws (best-effort);
   * degrade-clean when Project-Ops is unconfigured or there is no usable match
   * key. Read-only — Project-Ops owns the lifecycle; nothing is persisted here.
   */
  private async buildProjectPanel(
    user: User & Partial<WithWorkspaceClaim>,
    customerOpsCustomerId: string,
    contactOpsContactId: string,
    contact: FederatedContact | null,
    requestedWorkspaceId?: string | null,
  ): Promise<ProjectPanel> {
    const configured = this.projectOps.isConfigured();
    const base: ProjectPanel = {
      federated: configured,
      source: 'project-ops',
      configured,
      projects: [],
    };
    if (!configured) return base;

    const lookup: ProjectLookup = {
      customerOpsCustomerId,
      contactOpsContactId,
      orgName: contact?.currentOrgName ?? null,
      contactName: contact?.displayName ?? null,
    };
    // No usable match key (e.g. a provisional contact with no ids/org/name) → no call.
    if (
      !lookup.customerOpsCustomerId &&
      !lookup.contactOpsContactId &&
      !lookup.orgName &&
      !lookup.contactName
    ) {
      return base;
    }

    const fedCtx = await this.projectFederationContext(user, requestedWorkspaceId);
    try {
      base.projects = await this.projectOps.listProjectsForContact(fedCtx, lookup);
    } catch (err) {
      this.logger.warn(`Project panel federation failed: ${(err as Error).message}`);
    }
    return base;
  }

  // ---- Phase-4 federation helpers ----------------------------------------

  /** Build the Outreach federation identity (workspace + actor + entitlements). */
  private async outreachFederationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<OutreachFederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return {
      workspaceId,
      ucUid: ucUidOf(user) || null,
      entitlements: await this.workspaces.effectiveEntitlements(user, workspaceId),
    };
  }

  /** Build the Email-Ops federation identity (workspace + actor + entitlements). */
  private async emailFederationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<EmailFederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return {
      workspaceId,
      ucUid: ucUidOf(user) || null,
      entitlements: await this.workspaces.effectiveEntitlements(user, workspaceId),
    };
  }

  /**
   * Assemble the customer-360 outreach panel: list the live campaigns (the
   * "start" picker) + the live touches for the contact (history), federated from
   * the Outreach app, alongside the local enrollment links. Never throws
   * (best-effort); degrade-clean + entitlement affordances mirror the invoice
   * panel. Reads are viewer-level (no dual SKU); only the trigger action is gated.
   */
  private async buildOutreachPanel(
    user: User & Partial<WithWorkspaceClaim>,
    contactId: string,
    links: Array<Record<string, any>>,
    requestedWorkspaceId?: string | null,
  ) {
    const configured = this.outreach.isConfigured();
    const fedCtx = configured
      ? await this.outreachFederationContext(user, requestedWorkspaceId)
      : null;
    const entitled = fedCtx ? this.outreach.checkEntitlement(fedCtx).allowed : false;

    let campaigns: ReturnType<typeof this.serializeCampaign>[] = [];
    let touches: OutreachTouchView[] = [];
    if (configured && fedCtx) {
      try {
        const [rawCampaigns, rawTouches] = await Promise.all([
          this.outreach.listCampaigns(fedCtx),
          this.outreach.listTouchesForContact(fedCtx, contactId),
        ]);
        campaigns = rawCampaigns.map((c) => this.serializeCampaign(c));
        touches = rawTouches.map((t) => this.serializeTouch(t));
      } catch (err) {
        this.logger.warn(`Outreach panel federation failed: ${(err as Error).message}`);
      }
    }

    return {
      federated: configured,
      source: 'outreach',
      configured,
      entitled,
      // Triggering a campaign/touch requires the dual SKU; reads do not.
      canStart: configured && entitled,
      // The live campaigns to enroll into + the live touch history for the contact.
      campaigns,
      touches,
      // The local enrollment links THIS app initiated (de-dupe memory + cache).
      enrollments: links.map((l) => this.serializeOutreachLink(l)),
    };
  }

  /**
   * Assemble the customer-360 email panel: list the live mailbox threads with the
   * contact (history), federated from the Email-Ops app, alongside the local
   * outbound links. Never throws (best-effort); degrade-clean + entitlement
   * affordances mirror the invoice panel. Reads are viewer-level (no dual SKU);
   * only the send/draft action is gated.
   */
  private async buildEmailPanel(
    user: User & Partial<WithWorkspaceClaim>,
    contactId: string,
    links: Array<Record<string, any>>,
    requestedWorkspaceId?: string | null,
  ) {
    const configured = this.emailOps.isConfigured();
    const fedCtx = configured
      ? await this.emailFederationContext(user, requestedWorkspaceId)
      : null;
    const entitled = fedCtx ? this.emailOps.checkEntitlement(fedCtx).allowed : false;

    let threads: EmailThreadView[] = [];
    if (configured && fedCtx) {
      try {
        const raw = await this.emailOps.listThreadsWithContact(fedCtx, contactId);
        threads = raw.map((t) => this.serializeThread(t));
      } catch (err) {
        this.logger.warn(`Email panel federation failed: ${(err as Error).message}`);
      }
    }

    return {
      federated: configured,
      source: 'email-ops',
      configured,
      entitled,
      // Sending/drafting requires the dual SKU; reading threads does not.
      canSend: configured && entitled,
      // The live mailbox threads with the contact (federated; never stored).
      threads,
      // The local outbound links THIS app initiated (de-dupe memory + cache).
      sent: links.map((l) => this.serializeEmailLink(l)),
    };
  }

  /** Build the Conversations federation identity (workspace + actor + entitlements). */
  private async conversationsFederationContext(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<ConversationsFederationContext> {
    const workspaceId = await this.workspaces.resolveAuthorized(user, requestedWorkspaceId);
    return {
      workspaceId,
      ucUid: ucUidOf(user) || null,
      // Workspace-effective SKUs (token ∩ workspace), NEVER raw token claims —
      // token-claim entitlements would leak a SKU across workspaces (918c01a).
      entitlements: await this.workspaces.effectiveEntitlements(user, workspaceId),
    };
  }

  /**
   * Assemble the customer-360 conversations panel: the worker's device messaging
   * threads (iMessage + SMS) with the contact's handles, federated from the UUDC
   * device bridge. Never throws (best-effort); degrade-clean + entitlement +
   * per-workspace / per-channel flag affordances. Reads are viewer-level; only
   * sending is SKU-gated. Customer-Ops stores no message — the device is SoR.
   */
  private async buildConversationsPanel(
    user: User & Partial<WithWorkspaceClaim>,
    contact: FederatedContact | null,
    requestedWorkspaceId?: string | null,
  ) {
    const bridgeConfigured = this.conversationsOps?.isConfigured() ?? false;
    const fedCtx =
      bridgeConfigured && this.conversationsOps
        ? await this.conversationsFederationContext(user, requestedWorkspaceId)
        : null;
    const workspaceAllowed =
      !!fedCtx && (this.conversationsOps?.isWorkspaceAllowed(fedCtx.workspaceId) ?? false);
    // Surface as "configured" only when the bridge is up AND this workspace is
    // allowed (dogfood allowlist). Outside the allowlist the panel shows connect
    // rather than an empty thread list from a bridge the workspace cannot use.
    const configured = bridgeConfigured && workspaceAllowed;
    const entitled =
      fedCtx && this.conversationsOps
        ? this.conversationsOps.checkEntitlement(fedCtx).allowed
        : false;
    const activation = this.conversationsOps?.activation() ?? null;
    const enabledChannels = this.conversationsOps?.enabledChannels() ?? [];
    const liveSendEnabled = activation?.liveSendEnabled ?? false;

    // The contact's handles (phone e164 + email) — what device conversations key on.
    const handles = this.contactDeviceHandles(contact);

    let threads: ConversationThread[] = [];
    if (configured && fedCtx && this.conversationsOps && handles.length > 0) {
      try {
        threads = await this.conversationsOps.listConversationsForContact(fedCtx, handles);
      } catch (err) {
        this.logger.warn(`Conversations panel federation failed: ${(err as Error).message}`);
      }
    }

    return {
      federated: configured,
      source: 'conversations-ops',
      configured,
      entitled,
      // Compose UI when entitled + channel flags allow; may still dry-run.
      canSend: configured && entitled && enabledChannels.length > 0,
      liveSendEnabled,
      dryRunDefault: !liveSendEnabled,
      enabledChannels,
      // The live device conversations with the contact (federated; never stored).
      threads,
    };
  }

  /**
   * Standalone conversations panel endpoint (same payload as customer-360 slot).
   */
  async conversationsForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ) {
    const contactId = await this.workspaces.runForUser(
      user,
      async (tx) => (await this.getInTx(tx, customerId)).contactId,
      requestedWorkspaceId,
    );
    const contactCtx = await this.federationContext(user, requestedWorkspaceId);
    const contact = await this.contactOps.getContact(contactCtx, contactId);
    return this.buildConversationsPanel(user, contact, requestedWorkspaceId);
  }

  /** The federated contact's device handles (phone e164 + email) — what device
   *  conversations key on. */
  private contactDeviceHandles(contact: FederatedContact | null): string[] {
    return contact
      ? [...contact.phones.map((p) => p.e164), ...contact.emails.map((e) => e.address)].filter(
          (h): h is string => typeof h === 'string' && h.length > 0,
        )
      : [];
  }

  /** Normalize a device handle for ownership matching: emails lowercased, phones
   *  digits-only. MUST mirror ConversationsOpsClient.normHandle so this authz
   *  gate and the client's thread matching agree on handle identity. */
  private normalizeDeviceHandle(handle: string): string {
    const s = (handle || '').trim().toLowerCase();
    if (s.includes('@')) return s;
    return s.replace(/[^0-9]/g, '');
  }

  /**
   * Expand one device conversation (message previews). Viewer-level; degrade-clean
   * when the seam is dormant — but 404 when the requested chat does not belong to
   * THIS customer's contact (the device is the worker's personal Messages app;
   * an arbitrary chatId must never expand someone else's thread).
   */
  async conversationMessagesForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    chatId: string,
    requestedWorkspaceId?: string | null,
  ): Promise<{ chatId: string; messages: ConversationMessage[]; configured: boolean }> {
    // Authorize: customer must exist in the caller's workspace (RLS) — and
    // capture its contactId for the thread-ownership gate below.
    const contactId = await this.workspaces.runForUser(
      user,
      async (tx) => (await this.getInTx(tx, customerId)).contactId,
      requestedWorkspaceId,
    );

    if (!this.conversationsOps?.isConfigured()) {
      return { chatId, messages: [], configured: false };
    }
    const fedCtx = await this.conversationsFederationContext(user, requestedWorkspaceId);
    if (!this.conversationsOps.isWorkspaceAllowed(fedCtx.workspaceId)) {
      return { chatId, messages: [], configured: false };
    }

    // AUTHZ: the requested chat must belong to THIS customer's contact. Without
    // this gate any workspace viewer could read ANY thread on the worker's
    // personal device by passing an arbitrary phone number as chatId. Accept a
    // direct handle match (normalized), or membership in the contact's federated
    // thread list (covers group-chat ids like `chat123…` that are not a bare
    // handle). 404 otherwise — fail-closed, without confirming whether such a
    // thread exists on-device.
    const contactCtx = await this.federationContext(user, requestedWorkspaceId);
    const contact = await this.contactOps.getContact(contactCtx, contactId);
    const handles = this.contactDeviceHandles(contact);
    const wanted = new Set(
      handles.map((h) => this.normalizeDeviceHandle(h)).filter((h) => h.length > 0),
    );
    const normChatId = this.normalizeDeviceHandle(chatId);
    let chatAuthorized = normChatId.length > 0 && wanted.has(normChatId);
    if (!chatAuthorized && handles.length > 0) {
      try {
        const threads = await this.conversationsOps.listConversationsForContact(fedCtx, handles);
        chatAuthorized = threads.some(
          (t) => t.id === chatId || this.normalizeDeviceHandle(t.handle) === normChatId,
        );
      } catch (err) {
        this.logger.warn(`Conversation ownership check failed: ${(err as Error).message}`);
      }
    }
    if (!chatAuthorized) {
      throw new NotFoundException('No such conversation for this customer.');
    }

    let messages: ConversationMessage[] = [];
    try {
      messages = await this.conversationsOps.listMessagesInConversation(fedCtx, chatId);
    } catch (err) {
      this.logger.warn(`Conversation thread federation failed: ${(err as Error).message}`);
    }
    return { chatId, messages, configured: true };
  }

  /**
   * Send an iMessage/SMS via the device bridge. Defaults to dry-run unless
   * CONVERSATIONS_OPS_LIVE_SEND_ENABLED=true for the channel. Never stores body.
   * Aaron-attended checkpoint required before live dogfood/prod sends.
   */
  async sendMessageForUser(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    dto: SendMessageDto,
    requestedWorkspaceId?: string | null,
  ) {
    const ucUid = ucUidOf(user);
    if (!this.conversationsOps?.isConfigured()) {
      throw new BadRequestException(
        'Device messaging is not connected for this deployment. Set CONVERSATIONS_OPS_BASE_URL ' +
          '(and mTLS material when TRANSPORT=mtls) to enable iMessage/SMS. ' +
          'Customer-Ops federates the worker device via UUDC; it is not a message store.',
      );
    }
    const fedCtx = await this.conversationsFederationContext(user, requestedWorkspaceId);
    if (!this.conversationsOps.isWorkspaceAllowed(fedCtx.workspaceId)) {
      throw new ForbiddenException(
        'Device messaging is not enabled for this workspace. ' +
          'Add the workspace to CONVERSATIONS_OPS_WORKSPACE_ALLOWLIST for dogfood, ' +
          'or clear the allowlist once the channel is generally available.',
      );
    }
    const gate = this.conversationsOps.checkEntitlement(fedCtx);
    if (!gate.allowed) {
      this.logger.warn(
        `Device message send denied for ${ucUid} (ws=${fedCtx.workspaceId}): ${gate.reason}`,
      );
      throw new ForbiddenException(gate.reason);
    }

    // Runtime kill switch (workspace-scoped): halt outbound device dispatch when
    // this workspace is paused — every outbound dispatch gates on the workspace
    // kill switch (same doctrine as sendEmailForUser). Device sends have no
    // draft/approval mode, so the gate is unconditional (even a dry-run reaches
    // the device bridge).
    await this.workspaces.assertAgentsNotPaused(fedCtx.workspaceId);

    // Resolve recipient: explicit to, else federated contact's primary phone, else first email.
    let to = dto.to?.trim() || null;
    if (!to) {
      const contactId = await this.workspaces.runForUser(
        user,
        async (tx) => (await this.getInTx(tx, customerId)).contactId,
        requestedWorkspaceId,
      );
      const contactCtx = await this.federationContext(user, requestedWorkspaceId);
      const contact = await this.contactOps.getContact(contactCtx, contactId);
      to = contact?.phones?.[0]?.e164 ?? contact?.emails?.[0]?.address ?? null;
    }
    if (!to) {
      throw new BadRequestException(
        'No recipient handle: pass to, or ensure the federated contact has a phone/email. ' +
          'Customer-Ops does not store the handle.',
      );
    }

    // Normalize channel spelling to canonical DeviceChannel when provided.
    const channelRaw = dto.channel?.trim() || '';
    const channel =
      channelRaw.toLowerCase() === 'sms'
        ? 'SMS'
        : channelRaw.toLowerCase() === 'imessage'
          ? 'iMessage'
          : channelRaw;

    if (channel && !this.conversationsOps.isChannelEnabled(channel)) {
      throw new BadRequestException(
        `Channel '${channel}' is not enabled (CONVERSATIONS_OPS_CHANNELS). ` +
          `Enabled: ${this.conversationsOps.enabledChannels().join(', ') || '(none)'}.`,
      );
    }

    // Authorize customer exists in workspace (no local message row — device is SoR).
    await this.workspaces.runForUser(
      user,
      async (tx) => {
        await this.getInTx(tx, customerId);
      },
      requestedWorkspaceId,
    );

    const idemKey = dto.idempotencyKey?.trim() || randomUUID();
    const externalRef = `cust:${customerId}:msg:${idemKey}`;

    const result = await this.conversationsOps.sendMessage(fedCtx, {
      to,
      body: dto.body,
      channel: channel || undefined,
      externalRef,
    });
    if (!result) {
      throw new ServiceUnavailableException(
        'Device messaging bridge did not accept the message. Retry is safe (idempotent on externalRef).',
      );
    }

    // Timeline breadcrumb only — never the body. Marks dry-run honestly so ops
    // can tell a real send from a dogfood rehearsal.
    try {
      await this.workspaces.runForUser(
        user,
        async (tx) => {
          await this.getInTx(tx, customerId);
          const workspaceId = await this.boundWorkspaceId(tx);
          await tx.customerActivity.create({
            data: {
              workspaceId,
              customerId,
              kind: CustomerActivityKind.NOTE,
              // Timeline breadcrumb only — never the message body. dryRun is
              // called out so ops can distinguish a dogfood rehearsal from a live send.
              body: result.dryRun
                ? `Dry-run ${result.channel} → ${to} (not delivered; LIVE_SEND not enabled) [${externalRef}]`
                : `Sent ${result.channel} → ${to} [${externalRef}]`,
              actorUcUid: ucUid || null,
            },
          });
        },
        requestedWorkspaceId,
      );
    } catch (err) {
      this.logger.warn(
        `Device message activity note failed (send still returned): ${(err as Error).message}`,
      );
    }

    return {
      applied: result.applied,
      channel: result.channel,
      dryRun: result.dryRun,
      externalRef,
      to,
    };
  }

  /** The Prisma update payload refreshing an outreach link's cached projection. */
  private outreachCacheUpdate(r: OutreachEnrollmentResult): Prisma.CustomerOutreachLinkUpdateInput {
    return {
      outreachId: r.id,
      campaignId: r.campaignId ?? undefined,
      campaignName: r.campaignName ?? undefined,
      lastStatus: r.status,
      lastPolledAt: new Date(),
    };
  }

  /** The Prisma update payload refreshing an email link's cached projection. */
  private emailCacheUpdate(r: EmailComposeResult): Prisma.CustomerEmailLinkUpdateInput {
    return {
      messageId: r.id,
      threadId: r.threadId ?? undefined,
      lastStatus: r.status,
      lastPolledAt: new Date(),
    };
  }

  /** Serialize a CustomerOutreachLink row to the wire shape. */
  private serializeOutreachLink(row: Record<string, any>) {
    return {
      id: row.id,
      customerId: row.customerId,
      contactId: row.contactId,
      channel: row.channel ?? 'email',
      externalSource: row.externalSource,
      externalRef: row.externalRef,
      campaignId: row.campaignId ?? null,
      outreachId: row.outreachId ?? null,
      campaignName: row.campaignName ?? null,
      status: row.lastStatus ?? null,
      lastPolledAt: row.lastPolledAt ?? null,
      createdAt: row.createdAt,
    };
  }

  /** Serialize a CustomerEmailLink row to the wire shape. */
  private serializeEmailLink(row: Record<string, any>) {
    return {
      id: row.id,
      customerId: row.customerId,
      contactId: row.contactId,
      mode: row.mode ?? 'send',
      externalSource: row.externalSource,
      externalRef: row.externalRef,
      threadId: row.threadId ?? null,
      messageId: row.messageId ?? null,
      subject: row.subject ?? null,
      status: row.lastStatus ?? null,
      lastPolledAt: row.lastPolledAt ?? null,
      createdAt: row.createdAt,
    };
  }

  /** Serialize a federated Outreach campaign to the cockpit wire shape. */
  private serializeCampaign(c: {
    id: string;
    name: string;
    channel: string;
    status: string;
    isSequence: boolean;
    listId: string | null;
    createdAt: string | null;
  }) {
    return {
      id: c.id,
      name: c.name,
      channel: c.channel,
      status: c.status,
      isSequence: c.isSequence,
      createdAt: c.createdAt,
    };
  }

  /** Serialize a federated Outreach touch to the cockpit wire shape. */
  private serializeTouch(t: {
    id: string;
    channel: string;
    campaignId: string | null;
    campaignName: string | null;
    status: string;
    subject: string | null;
    scheduledAt: string | null;
    sentAt: string | null;
    lastEngagementKind: OutreachEngagementKind | null;
    lastEngagementAt: string | null;
  }): OutreachTouchView {
    return {
      id: t.id,
      channel: t.channel,
      campaignId: t.campaignId,
      campaignName: t.campaignName,
      status: t.status,
      subject: t.subject,
      scheduledAt: t.scheduledAt,
      sentAt: t.sentAt,
      lastEngagementKind: t.lastEngagementKind,
      lastEngagementAt: t.lastEngagementAt,
    };
  }

  /** Serialize a federated Email-Ops thread to the cockpit wire shape. */
  private serializeThread(t: {
    id: string;
    subject: string | null;
    messageCount: number;
    unread: boolean;
    lastMessageAt: string | null;
    lastSnippet: string | null;
    participants: Array<{ address: string; name: string | null }>;
  }): EmailThreadView {
    return {
      id: t.id,
      subject: t.subject,
      messageCount: t.messageCount,
      unread: t.unread,
      lastMessageAt: t.lastMessageAt,
      lastSnippet: t.lastSnippet,
      participants: t.participants,
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
      orderBy: [{ priority: 'desc' }, { lastStageChangeAt: 'asc' }, { id: 'asc' }],
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

  /** Post-commit, fire-and-forget graph refresh for one customer. Best-effort:
   *  resolves the workspace, then MERGEs that customer's subgraph. upsertCustomer
   *  swallows its own errors + no-ops when the graph is dormant; the .catch guards
   *  the workspace resolve so a floating rejection can never surface. */
  private refreshGraph(
    user: User & Partial<WithWorkspaceClaim>,
    customerId: string,
    requestedWorkspaceId?: string | null,
  ): void {
    if (!this.graphIngest) return;
    void this.workspaces
      .resolveAuthorized(user, requestedWorkspaceId)
      .then((ws) => this.graphIngest!.upsertCustomer(ws, customerId))
      .catch(() => undefined);
  }

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
    user: User & Partial<WithWorkspaceClaim>,
    fedCtx: FederationContext,
    rows: Array<Record<string, any>>,
    withContacts: boolean,
    requestedWorkspaceId?: string | null,
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

      // Phase-6 provisional fallback: any contactId the canonical phonebook did
      // NOT resolve AND that is a local provisional id ('prov:…') gets its label
      // from the lead-intake buffer — so an ingested lead renders with a real
      // name while Contact-Ops is dormant. Clearly a fallback, never a contact
      // store; it vanishes once reconciliation swaps in the canonical person.
      if (this.leadLabels) {
        const unresolvedProvisional = [...new Set(ids)].filter(
          (id) => isProvisionalContactId(id) && !summaries.has(id),
        );
        if (unresolvedProvisional.length) {
          const labels = await this.leadLabels.labels(
            user,
            requestedWorkspaceId ?? null,
            unresolvedProvisional,
          );
          for (const [id, l] of labels) {
            summaries.set(id, {
              displayName: l.displayName,
              primaryEmail: l.primaryEmail,
              currentOrgName: l.currentOrgName,
              tags: l.tags,
            });
          }
        }
      }
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
