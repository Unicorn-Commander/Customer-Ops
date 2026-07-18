import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditAction, User } from '@prisma/client';
import { GdprService } from './gdpr.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { MembershipService } from '../common/workspace/membership.service';
import { AuditService } from '../audit/audit.service';
import { GraphIngestService } from '../graph/graph-ingest.service';

/**
 * GdprService — the CRM data-lifecycle logic (erasure / export / offboard /
 * retention). These specs pin:
 *   - OWNER-gating: every entry point calls MembershipService.assertOwner first;
 *     a non-owner is 403'd BEFORE any delete/read.
 *   - ERASURE: children (incl. lead_intakes PII) deleted before the customer, the
 *     FalkorDB subgraph cleaned, and a DELETE audit row written with ONLY
 *     structural metadata (never the contactId/PII).
 *   - EXPORT: a portable envelope of the workspace/subject records + an EXPORT
 *     audit row.
 *   - OFFBOARD: delete wipes all CRM data + drops the graph + archives the ws;
 *     anonymize strips PII but keeps the skeleton.
 *   - degrade-clean: the graph port is @Optional (erasure completes without it).
 *
 * The GUC chokepoint is faked (runInWorkspace invokes fn(tx) directly); the real
 * RLS is proven separately in the SQL acceptance.
 */

const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';
const owner = { id: 'local-aaron', email: 'aaron@magicunicorn.tech', keycloakId: UC_UID } as User;

function makeCustomer(over: Record<string, any> = {}) {
  return { id: 'cust-1', workspaceId: WS, contactId: 'contact-1', stage: 'LEAD', ...over };
}

/** A fake workspace-bound tx exposing the finders/mutators GdprService uses. */
function makeTx(opts: { customer?: any | null } = {}) {
  const customer = 'customer' in opts ? opts.customer : makeCustomer();
  const del = (n: number) => jest.fn().mockResolvedValue({ count: n });
  return {
    customer: {
      findUnique: jest.fn().mockResolvedValue(customer),
      findMany: jest.fn().mockResolvedValue(customer ? [customer] : []),
      delete: jest.fn().mockResolvedValue(customer),
      deleteMany: del(customer ? 1 : 0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    customerActivity: {
      findMany: jest.fn().mockResolvedValue([{ id: 'act-1' }]),
      deleteMany: del(2),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    customerInvoiceLink: { findMany: jest.fn().mockResolvedValue([]), deleteMany: del(0) },
    customerOutreachLink: { findMany: jest.fn().mockResolvedValue([]), deleteMany: del(0) },
    customerEmailLink: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: del(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    leadIntake: { findMany: jest.fn().mockResolvedValue([{ id: 'li-1' }]), deleteMany: del(3) },
  };
}

function makeWorkspaces(tx: any): WorkspaceContextService {
  return {
    runInWorkspace: jest.fn(async (_ws: string, _uid: any, fn: (t: any) => any) => fn(tx)),
  } as unknown as WorkspaceContextService;
}

function makeMembership(isOwner = true): MembershipService {
  return {
    assertOwner: jest.fn(async () => {
      if (!isOwner) throw new ForbiddenException('Only the workspace owner can manage members.');
    }),
    getWorkspaceOrThrow: jest.fn(async () => ({ id: WS })),
  } as unknown as MembershipService;
}

function makeAudit(): { svc: AuditService; rows: any[] } {
  const rows: any[] = [];
  const svc = {
    log: jest.fn(async (dto: any) => {
      rows.push(dto);
      return dto;
    }),
  } as unknown as AuditService;
  return { svc, rows };
}

function makeGraph(): { svc: GraphIngestService; calls: any } {
  const calls = { erase: [] as any[], purge: [] as any[] };
  const svc = {
    eraseCustomer: jest.fn(async (ws: string, cid: string, custId: string) => {
      calls.erase.push({ ws, cid, custId });
      return 2;
    }),
    purgeWorkspace: jest.fn(async (ws: string) => {
      calls.purge.push({ ws });
      return true;
    }),
  } as unknown as GraphIngestService;
  return { svc, calls };
}

function makePrisma(): { svc: PrismaService; updates: any[] } {
  const updates: any[] = [];
  const svc = {
    workspace: {
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return { id: WS, retentionDays: args.data.retentionDays ?? null, ...args.data };
      }),
    },
  } as unknown as PrismaService;
  return { svc, updates };
}

describe('GdprService', () => {
  describe('eraseCustomerForUser', () => {
    it('owner-gates, deletes children + the customer, cleans the graph, audits DELETE', async () => {
      const tx = makeTx();
      const membership = makeMembership(true);
      const audit = makeAudit();
      const graph = makeGraph();
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        membership,
        audit.svc,
        graph.svc,
      );

      const res = await svc.eraseCustomerForUser(owner, WS, 'cust-1');

      expect(membership.assertOwner).toHaveBeenCalledWith(owner, WS);
      expect(tx.customerActivity.deleteMany).toHaveBeenCalledWith({ where: { customerId: 'cust-1' } });
      expect(tx.leadIntake.deleteMany).toHaveBeenCalledWith({ where: { customerId: 'cust-1' } });
      expect(tx.customer.delete).toHaveBeenCalledWith({ where: { id: 'cust-1' } });
      // graph cleaned with the erased customer's contactId + id.
      expect(graph.calls.erase).toEqual([{ ws: WS, cid: 'contact-1', custId: 'cust-1' }]);
      // DELETE audit written, structural only — NEVER the contactId/PII.
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].action).toBe(AuditAction.DELETE);
      expect(audit.rows[0].resource).toBe('customer');
      expect(audit.rows[0].resourceId).toBe('cust-1');
      expect(JSON.stringify(audit.rows[0].details)).not.toContain('contact-1');
      expect(res.erased).toBe(true);
      expect(res.removed.leadIntakes).toBe(3);
      expect(res.graphNodesDeleted).toBe(2);
    });

    it('404s when the customer is not visible (no delete, no audit)', async () => {
      const tx = makeTx({ customer: null });
      const audit = makeAudit();
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        makeMembership(true),
        audit.svc,
        makeGraph().svc,
      );

      await expect(svc.eraseCustomerForUser(owner, WS, 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.customer.delete).not.toHaveBeenCalled();
      expect(audit.rows).toHaveLength(0);
    });

    it('403s a non-owner before any delete', async () => {
      const tx = makeTx();
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        makeMembership(false),
        makeAudit().svc,
        makeGraph().svc,
      );

      await expect(svc.eraseCustomerForUser(owner, WS, 'cust-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tx.customer.delete).not.toHaveBeenCalled();
    });

    it('completes without the graph port (degrade-clean: 0 graph nodes)', async () => {
      const tx = makeTx();
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        makeMembership(true),
        makeAudit().svc,
        undefined, // graph module unwired
      );

      const res = await svc.eraseCustomerForUser(owner, WS, 'cust-1');
      expect(res.erased).toBe(true);
      expect(res.graphNodesDeleted).toBe(0);
    });
  });

  describe('exports', () => {
    it('exportWorkspaceForUser returns a portable envelope + audits EXPORT', async () => {
      const tx = makeTx();
      const audit = makeAudit();
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        makeMembership(true),
        audit.svc,
        makeGraph().svc,
      );

      const doc: any = await svc.exportWorkspaceForUser(owner, WS);

      expect(doc.format).toBe('customer-ops.gdpr-export');
      expect(doc.workspace_id).toBe(WS);
      expect(doc.records.customers).toHaveLength(1);
      expect(audit.rows[0].action).toBe(AuditAction.EXPORT);
      expect(audit.rows[0].resource).toBe('workspace');
      expect(audit.rows[0].details.counts.customers).toBe(1);
    });

    it('exportCustomerForUser 404s a missing subject', async () => {
      const tx = makeTx({ customer: null });
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        makeMembership(true),
        makeAudit().svc,
        makeGraph().svc,
      );
      await expect(svc.exportCustomerForUser(owner, WS, 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('exportCustomerForUser stamps the subject + audits EXPORT(customer)', async () => {
      const tx = makeTx();
      const audit = makeAudit();
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(tx),
        makeMembership(true),
        audit.svc,
        makeGraph().svc,
      );

      const doc: any = await svc.exportCustomerForUser(owner, WS, 'cust-1');
      expect(doc.subject).toEqual({ customerId: 'cust-1', contactId: 'contact-1' });
      expect(audit.rows[0].action).toBe(AuditAction.EXPORT);
      expect(audit.rows[0].resource).toBe('customer');
    });
  });

  describe('offboardWorkspaceForUser', () => {
    it('delete mode wipes CRM data, purges the graph, archives the ws, audits DELETE', async () => {
      const tx = makeTx();
      const audit = makeAudit();
      const graph = makeGraph();
      const prisma = makePrisma();
      const svc = new GdprService(
        prisma.svc,
        makeWorkspaces(tx),
        makeMembership(true),
        audit.svc,
        graph.svc,
      );

      const res = await svc.offboardWorkspaceForUser(owner, WS, 'delete');

      expect(tx.customer.deleteMany).toHaveBeenCalled();
      expect(tx.leadIntake.deleteMany).toHaveBeenCalled();
      expect(graph.calls.purge).toEqual([{ ws: WS }]);
      expect(prisma.updates[0]).toMatchObject({ where: { id: WS }, data: { status: 'archived' } });
      expect(audit.rows[0].action).toBe(AuditAction.DELETE);
      expect(audit.rows[0].resource).toBe('workspace');
      expect(audit.rows[0].details.mode).toBe('delete');
      expect(res.graphPurged).toBe(true);
    });

    it('anonymize mode strips PII (deletes intakes, nulls fields) but keeps rows, no archive', async () => {
      const tx = makeTx();
      const prisma = makePrisma();
      const svc = new GdprService(
        prisma.svc,
        makeWorkspaces(tx),
        makeMembership(true),
        makeAudit().svc,
        makeGraph().svc,
      );

      const res = await svc.offboardWorkspaceForUser(owner, WS, 'anonymize');

      expect(tx.leadIntake.deleteMany).toHaveBeenCalled();
      expect(tx.customer.updateMany).toHaveBeenCalledWith({ data: { notes: null, source: null } });
      expect(tx.customer.deleteMany).not.toHaveBeenCalled();
      // No workspace archive on anonymize.
      expect(prisma.updates).toHaveLength(0);
      expect(res.mode).toBe('anonymize');
    });
  });

  describe('setRetentionForUser', () => {
    it('owner-gates, writes the column, audits UPDATE', async () => {
      const prisma = makePrisma();
      const audit = makeAudit();
      const svc = new GdprService(
        prisma.svc,
        makeWorkspaces(makeTx()),
        makeMembership(true),
        audit.svc,
        makeGraph().svc,
      );

      const res = await svc.setRetentionForUser(owner, WS, 90);
      expect(prisma.updates[0]).toMatchObject({ data: { retentionDays: 90 } });
      expect(res.retentionDays).toBe(90);
      expect(audit.rows[0].action).toBe(AuditAction.UPDATE);
      expect(audit.rows[0].resource).toBe('workspace_retention');
    });

    it('rejects a non-positive window', async () => {
      const svc = new GdprService(
        makePrisma().svc,
        makeWorkspaces(makeTx()),
        makeMembership(true),
        makeAudit().svc,
        makeGraph().svc,
      );
      await expect(svc.setRetentionForUser(owner, WS, 0)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts null to disable retention', async () => {
      const prisma = makePrisma();
      const svc = new GdprService(
        prisma.svc,
        makeWorkspaces(makeTx()),
        makeMembership(true),
        makeAudit().svc,
        makeGraph().svc,
      );
      const res = await svc.setRetentionForUser(owner, WS, null);
      expect(res.retentionDays).toBeNull();
      expect(prisma.updates[0]).toMatchObject({ data: { retentionDays: null } });
    });
  });
});
