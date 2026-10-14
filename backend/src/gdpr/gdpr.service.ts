/**
 * GdprService — the data-lifecycle (right-to-erasure + right-to-portability)
 * logic of Customer-Ops.
 *
 * This is the ONE place the CRM's destructive + export operations live, and it
 * honors the same fences the rest of the cockpit does:
 *
 *   - TENANCY (RLS): every Postgres read/delete/update runs inside the workspace
 *     GUC transaction (WorkspaceContextService.runInWorkspace →
 *     PrismaService.withWorkspace), so a caller can only ever erase/export the
 *     rows of the workspace on the path. The FalkorDB cleanup uses the graph
 *     tenancy chokepoint (graphKeyFor) via GraphIngestService.
 *   - RBAC: every entry point is OWNER-gated (MembershipService.assertOwner) —
 *     erasure + offboarding are the most consequential actions in the app, so
 *     they require the workspace owner, exactly like member management. The
 *     controller additionally marks the routes session-only (@JwtOnly) so a
 *     leaked PAT can never erase or exfiltrate a workspace's PII.
 *   - AUDIT: every erasure writes an AuditAction.DELETE row and every export an
 *     AuditAction.EXPORT row through the append-only trail (AuditService.log,
 *     which never throws + writes through the workspace GUC). The DELETE audit
 *     row deliberately OUTLIVES the data it records (audit_logs is INSERT-only
 *     for the runtime role) — the compliance record of an erasure is itself
 *     retained, per GDPR accountability.
 *
 * DEGRADE-CLEAN: the Postgres delete is authoritative; the FalkorDB cleanup is
 * best-effort (no-ops when the graph is dormant and never throws), so an erasure
 * always completes on the system-of-record even on a node where the graph isn't
 * wired.
 *
 * PII posture: audit `details` carry ONLY structural metadata (counts, mode,
 * reason) — never the contact id, name, or email. The export RESPONSE body is
 * the portability payload and does carry the subject's data (that is its
 * purpose); the audit row records that an export happened, not what was in it.
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditAction, User } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { MembershipService } from '../common/workspace/membership.service';
import { WithWorkspaceClaim, ucUidOf } from '../common/workspace/workspace.util';
import { AuditService } from '../audit/audit.service';
import { GraphIngestService } from '../graph/graph-ingest.service';

type AuthedUser = User & Partial<WithWorkspaceClaim>;

/** The offboarding disposition for a whole workspace's CRM data. */
export type OffboardMode = 'delete' | 'anonymize';

/** Result of a single-customer erasure (counts are structural, no PII). */
export interface ErasureResult {
  erased: boolean;
  customerId: string;
  /** Per-table row counts removed from Postgres. */
  removed: {
    customers: number;
    activities: number;
    invoiceLinks: number;
    outreachLinks: number;
    emailLinks: number;
    leadIntakes: number;
  };
  /** Graph node keys DETACH-deleted (0 when the graph is dormant). */
  graphNodesDeleted: number;
}

@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceContextService,
    private readonly membership: MembershipService,
    private readonly audit: AuditService,
    // @Optional so the data-lifecycle layer has no hard dependency on the
    // knowledge-graph module — when the graph is unwired the erasure/offboard
    // still completes on the Postgres system-of-record (degrade-clean).
    @Optional()
    private readonly graphIngest?: GraphIngestService,
  ) {}

  // =========================================================================
  // RIGHT TO ERASURE — one data subject (customer)
  // =========================================================================

  /**
   * Erase ONE customer (GDPR right-to-erasure): remove the relationship + all
   * its PII-bearing rows from Postgres, clean the FalkorDB subgraph, and record a
   * DELETE audit row. Owner-gated. 404 when the customer is not visible in the
   * workspace (RLS) / already gone.
   */
  async eraseCustomerForUser(
    user: AuthedUser,
    workspaceId: string,
    customerId: string,
  ): Promise<ErasureResult> {
    await this.membership.assertOwner(user, workspaceId);
    const result = await this.eraseCustomerCore(
      workspaceId,
      customerId,
      ucUidOf(user),
      'erasure-request',
    );
    if (!result.erased) {
      throw new NotFoundException('Customer not found in this workspace.');
    }
    return result;
  }

  /**
   * The shared erasure primitive used by BOTH the owner-gated endpoint and the
   * retention sweep (which passes a null actor + 'retention' reason). Does NOT
   * gate — the caller owns authorization. Returns `erased: false` (never throws)
   * when the customer is not present, so the sweep can skip cleanly.
   *
   * Order: children (incl. lead_intakes, which the FK would only SET NULL, so we
   * delete them explicitly to remove the raw inbound identity PII) → the customer
   * row, all inside ONE workspace-GUC transaction. Then the best-effort graph
   * cleanup + the DELETE audit row (both outside the tx; audit never throws).
   */
  async eraseCustomerCore(
    workspaceId: string,
    customerId: string,
    actorUcUid: string | null,
    reason: string,
  ): Promise<ErasureResult> {
    const tx = await this.workspaces.runInWorkspace(
      workspaceId,
      actorUcUid,
      async (t: WorkspaceTxClient) => {
        const customer = await t.customer.findUnique({ where: { id: customerId } });
        if (!customer) return null;

        // Children first (no inter-dependency among them). lead_intakes holds the
        // raw inbound identity (name/email/phone) — DELETE (not the FK's SET NULL)
        // so the PII is actually erased, not merely detached.
        const [activities, invoiceLinks, outreachLinks, emailLinks, leadIntakes] =
          await Promise.all([
            t.customerActivity.deleteMany({ where: { customerId } }),
            t.customerInvoiceLink.deleteMany({ where: { customerId } }),
            t.customerOutreachLink.deleteMany({ where: { customerId } }),
            t.customerEmailLink.deleteMany({ where: { customerId } }),
            t.leadIntake.deleteMany({ where: { customerId } }),
          ]);
        await t.customer.delete({ where: { id: customerId } });

        return {
          contactId: customer.contactId,
          removed: {
            customers: 1,
            activities: activities.count,
            invoiceLinks: invoiceLinks.count,
            outreachLinks: outreachLinks.count,
            emailLinks: emailLinks.count,
            leadIntakes: leadIntakes.count,
          },
        };
      },
    );

    if (!tx) {
      return {
        erased: false,
        customerId,
        removed: {
          customers: 0,
          activities: 0,
          invoiceLinks: 0,
          outreachLinks: 0,
          emailLinks: 0,
          leadIntakes: 0,
        },
        graphNodesDeleted: 0,
      };
    }

    // Best-effort graph cleanup (never throws; no-ops when dormant).
    let graphNodesDeleted = 0;
    if (this.graphIngest) {
      graphNodesDeleted = await this.graphIngest.eraseCustomer(
        workspaceId,
        tx.contactId,
        customerId,
      );
    }

    // DELETE audit — structural metadata only (reason + counts), NEVER the
    // contact id/name/email (the erased PII must not resurface in the trail).
    await this.audit.log({
      workspaceId,
      userId: actorUcUid ?? undefined,
      action: AuditAction.DELETE,
      resource: 'customer',
      resourceId: customerId,
      details: { reason, removed: tx.removed, graphNodesDeleted },
    });

    return { erased: true, customerId, removed: tx.removed, graphNodesDeleted };
  }

  // =========================================================================
  // RIGHT TO PORTABILITY — export
  // =========================================================================

  /**
   * Export the WHOLE workspace's CRM records as a portable JSON document, and
   * record an EXPORT audit row. Owner-gated. The relationship projection + its
   * activity/link/intake rows — everything Customer-Ops OWNS for the workspace.
   */
  async exportWorkspaceForUser(
    user: AuthedUser,
    workspaceId: string,
  ): Promise<Record<string, unknown>> {
    await this.membership.assertOwner(user, workspaceId);
    const actor = ucUidOf(user);

    const payload = await this.workspaces.runInWorkspace(
      workspaceId,
      actor,
      async (t: WorkspaceTxClient) => {
        const [customers, activities, invoiceLinks, outreachLinks, emailLinks, leadIntakes] =
          await Promise.all([
            t.customer.findMany({ orderBy: { createdAt: 'asc' } }),
            t.customerActivity.findMany({ orderBy: { createdAt: 'asc' } }),
            t.customerInvoiceLink.findMany({ orderBy: { createdAt: 'asc' } }),
            t.customerOutreachLink.findMany({ orderBy: { createdAt: 'asc' } }),
            t.customerEmailLink.findMany({ orderBy: { createdAt: 'asc' } }),
            t.leadIntake.findMany({ orderBy: { createdAt: 'asc' } }),
          ]);
        return { customers, activities, invoiceLinks, outreachLinks, emailLinks, leadIntakes };
      },
    );

    const doc = this.wrapExport(workspaceId, actor, null, payload);
    await this.audit.log({
      workspaceId,
      userId: actor || undefined,
      action: AuditAction.EXPORT,
      resource: 'workspace',
      resourceId: workspaceId,
      details: { scope: 'workspace', counts: this.countsOf(payload) },
    });
    return doc;
  }

  /**
   * Export ONE data subject (customer) as a portable JSON document, and record an
   * EXPORT audit row. Owner-gated. 404 when the customer is not visible in the
   * workspace.
   */
  async exportCustomerForUser(
    user: AuthedUser,
    workspaceId: string,
    customerId: string,
  ): Promise<Record<string, unknown>> {
    await this.membership.assertOwner(user, workspaceId);
    const actor = ucUidOf(user);

    const payload = await this.workspaces.runInWorkspace(
      workspaceId,
      actor,
      async (t: WorkspaceTxClient) => {
        const customer = await t.customer.findUnique({ where: { id: customerId } });
        if (!customer) return null;
        const [activities, invoiceLinks, outreachLinks, emailLinks, leadIntakes] =
          await Promise.all([
            t.customerActivity.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
            t.customerInvoiceLink.findMany({
              where: { customerId },
              orderBy: { createdAt: 'asc' },
            }),
            t.customerOutreachLink.findMany({
              where: { customerId },
              orderBy: { createdAt: 'asc' },
            }),
            t.customerEmailLink.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
            t.leadIntake.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
          ]);
        return {
          contactId: customer.contactId,
          data: {
            customers: [customer],
            activities,
            invoiceLinks,
            outreachLinks,
            emailLinks,
            leadIntakes,
          },
        };
      },
    );

    if (!payload) throw new NotFoundException('Customer not found in this workspace.');

    const doc = this.wrapExport(
      workspaceId,
      actor,
      { customerId, contactId: payload.contactId },
      payload.data,
    );
    await this.audit.log({
      workspaceId,
      userId: actor || undefined,
      action: AuditAction.EXPORT,
      resource: 'customer',
      resourceId: customerId,
      details: { scope: 'customer', counts: this.countsOf(payload.data) },
    });
    return doc;
  }

  // =========================================================================
  // WORKSPACE OFFBOARDING — delete / anonymize a whole workspace's CRM data
  // =========================================================================

  /**
   * Offboard a whole workspace's CRM data + its FalkorDB graph. Owner-gated.
   *
   *   mode='delete'    — remove every relationship, activity, link, and intake
   *                      row (RLS-scoped), archive the workspace control row, and
   *                      drop the entire per-workspace graph.
   *   mode='anonymize' — keep the funnel skeleton for analytics but strip the
   *                      PII/free-text: delete the raw lead-intake buffer, null
   *                      customer.notes/source, activity bodies, and email
   *                      subjects; still drop the graph (it holds names/emails).
   *
   * Records a DELETE audit row (which survives — audit_logs is append-only).
   */
  async offboardWorkspaceForUser(
    user: AuthedUser,
    workspaceId: string,
    mode: OffboardMode,
  ): Promise<{ mode: OffboardMode; counts: Record<string, number>; graphPurged: boolean }> {
    await this.membership.assertOwner(user, workspaceId);
    const actor = ucUidOf(user);

    const counts = await this.workspaces.runInWorkspace(
      workspaceId,
      actor,
      async (t: WorkspaceTxClient): Promise<Record<string, number>> => {
        if (mode === 'anonymize') {
          // Delete the raw inbound-identity buffer outright (it exists to hold
          // PII), then strip free-text on the retained skeleton rows.
          const leadIntakes = await t.leadIntake.deleteMany({});
          const customers = await t.customer.updateMany({ data: { notes: null, source: null } });
          const activities = await t.customerActivity.updateMany({ data: { body: null } });
          const emailLinks = await t.customerEmailLink.updateMany({ data: { subject: null } });
          return {
            leadIntakes: leadIntakes.count,
            customers: customers.count,
            activities: activities.count,
            emailLinks: emailLinks.count,
          };
        }
        // delete: wipe all CRM data. Children before parent (FKs).
        const [activities, invoiceLinks, outreachLinks, emailLinks, leadIntakes] =
          await Promise.all([
            t.customerActivity.deleteMany({}),
            t.customerInvoiceLink.deleteMany({}),
            t.customerOutreachLink.deleteMany({}),
            t.customerEmailLink.deleteMany({}),
            t.leadIntake.deleteMany({}),
          ]);
        const customers = await t.customer.deleteMany({});
        return {
          customers: customers.count,
          activities: activities.count,
          invoiceLinks: invoiceLinks.count,
          outreachLinks: outreachLinks.count,
          emailLinks: emailLinks.count,
          leadIntakes: leadIntakes.count,
        };
      },
    );

    // Drop the whole per-workspace graph (best-effort; no-op when dormant).
    let graphPurged = false;
    if (this.graphIngest) graphPurged = await this.graphIngest.purgeWorkspace(workspaceId);

    // Mark the control row archived on a full delete (best-effort — the CRM data
    // is already gone; a status-write failure must not fail the offboarding).
    if (mode === 'delete') {
      try {
        await this.prisma.workspace.update({
          where: { id: workspaceId },
          data: { status: 'archived' },
        });
      } catch (err) {
        this.logger.warn(
          `offboard: could not archive workspace ${workspaceId}: ${(err as Error).message}`,
        );
      }
    }

    await this.audit.log({
      workspaceId,
      userId: actor || undefined,
      action: AuditAction.DELETE,
      resource: 'workspace',
      resourceId: workspaceId,
      details: { reason: 'offboard', mode, counts, graphPurged },
    });

    return { mode, counts, graphPurged };
  }

  // =========================================================================
  // RETENTION SETTING (owner-gated)
  // =========================================================================

  /**
   * Set (or clear) the workspace's data-retention window. `null` disables
   * retention (the default); a positive integer sets the DORMANT-record purge
   * window in days. Owner-gated; records an UPDATE audit row. `workspaces` is the
   * control table (not RLS-fenced), so this writes through the plain client.
   */
  async setRetentionForUser(
    user: AuthedUser,
    workspaceId: string,
    retentionDays: number | null,
  ): Promise<{ workspaceId: string; retentionDays: number | null }> {
    await this.membership.assertOwner(user, workspaceId);
    if (retentionDays != null && (!Number.isInteger(retentionDays) || retentionDays <= 0)) {
      throw new ForbiddenException('retentionDays must be a positive integer or null.');
    }
    // Ensure the workspace exists (404 otherwise) before the write.
    await this.membership.getWorkspaceOrThrow(workspaceId);

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { retentionDays },
    });
    await this.audit.log({
      workspaceId,
      userId: ucUidOf(user) || undefined,
      action: AuditAction.UPDATE,
      resource: 'workspace_retention',
      resourceId: workspaceId,
      details: { retentionDays },
    });
    return { workspaceId, retentionDays: updated.retentionDays ?? null };
  }

  // =========================================================================
  // helpers
  // =========================================================================

  /** Wrap a record bundle in the portable export envelope (versioned + stamped). */
  private wrapExport(
    workspaceId: string,
    actorUcUid: string,
    subject: { customerId: string; contactId: string } | null,
    data: unknown,
  ): Record<string, unknown> {
    return {
      format: 'customer-ops.gdpr-export',
      version: 1,
      workspace_id: workspaceId,
      generated_at: new Date().toISOString(),
      generated_by: actorUcUid || null,
      subject,
      records: data,
    };
  }

  /** Row counts of an export bundle (structural — safe for the audit trail). */
  private countsOf(bundle: {
    customers: unknown[];
    activities: unknown[];
    invoiceLinks: unknown[];
    outreachLinks: unknown[];
    emailLinks: unknown[];
    leadIntakes: unknown[];
  }): Record<string, number> {
    return {
      customers: bundle.customers.length,
      activities: bundle.activities.length,
      invoiceLinks: bundle.invoiceLinks.length,
      outreachLinks: bundle.outreachLinks.length,
      emailLinks: bundle.emailLinks.length,
      leadIntakes: bundle.leadIntakes.length,
    };
  }
}
