import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditAction, CustomerActivityKind, RelationshipStage, User } from '@prisma/client';
import { CustomersService } from './customers.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';
import { OutreachPort } from '../outreach-ops/outreach-ops.port';
import { EmailOpsPort } from '../email-ops/email-ops.port';
import { MeetingOpsPort } from '../meeting-ops/meeting-ops.port';
import { ProjectOpsPort } from '../project-ops/project-ops.port';
import { AuditService } from '../audit/audit.service';

/**
 * CustomersService is the relationship logic of the cockpit. These tests pin:
 *   - stage transitions enforce the funnel rules AND log an activity row in the
 *     same tx (timeline can never drift from the stage),
 *   - mark-lost / reopen toggle the orthogonal lost flag + log,
 *   - create rejects a duplicate (workspace, contact) relationship,
 *   - the customer-360 stitches the LOCAL relationship with the FEDERATED
 *     contact (Contact-Ops MOCKED) and leaves Phase-3 slots empty,
 *   - the list/board join federates contact summaries (never copies them).
 *
 * The tx-scoped methods take a fake transaction client; the federation port is a
 * mock — Contact-Ops is never running. The GUC chokepoint is faked by running
 * `fn(tx)` directly (the real RLS is proven separately in the SQL acceptance).
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';

const aaron = { id: 'local-aaron', email: 'aaron@magicunicorn.tech', keycloakId: UC_UID } as User;

function makeRow(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'cust-1',
    workspaceId: WS,
    contactId: 'contact-1',
    stage: RelationshipStage.LEAD,
    priority: 'MEDIUM',
    source: null,
    notes: null,
    ownerUserKey: null,
    expectedValue: null,
    currency: 'USD',
    nextActionAt: null,
    isLost: false,
    lostReason: null,
    closedLostAt: null,
    lastStageChangeAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

/**
 * A fake workspace-bound tx client. Records customerActivity.create calls so we
 * can assert the timeline write. `current_workspace_id()` returns WS (the GUC).
 */
function makeTx(customerRow: any) {
  const activities: any[] = [];
  const invoiceLinks: any[] = [];
  const outreachLinks: any[] = [];
  const emailLinks: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ ws: WS }]),
    customer: {
      findUnique: jest.fn().mockResolvedValue(customerRow),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(customerRow ? [customerRow] : []),
      create: jest.fn(async ({ data }: any) => makeRow({ ...data, id: 'cust-new' })),
      update: jest.fn(async ({ data }: any) => ({ ...customerRow, ...data })),
    },
    customerActivity: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `act-${activities.length + 1}`, createdAt: new Date(), ...data };
        activities.push(row);
        return row;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    customerInvoiceLink: {
      findMany: jest.fn().mockResolvedValue(invoiceLinks),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `link-${invoiceLinks.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        invoiceLinks.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = invoiceLinks.findIndex((l) => l.id === where.id);
        const merged = { ...(invoiceLinks[idx] ?? { id: where.id }), ...data };
        if (idx >= 0) invoiceLinks[idx] = merged;
        return merged;
      }),
    },
    customerOutreachLink: {
      findMany: jest.fn().mockResolvedValue(outreachLinks),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `orl-${outreachLinks.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        outreachLinks.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = outreachLinks.findIndex((l) => l.id === where.id);
        const merged = { ...(outreachLinks[idx] ?? { id: where.id }), ...data };
        if (idx >= 0) outreachLinks[idx] = merged;
        return merged;
      }),
    },
    customerEmailLink: {
      findMany: jest.fn().mockResolvedValue(emailLinks),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `eml-${emailLinks.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        emailLinks.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = emailLinks.findIndex((l) => l.id === where.id);
        const merged = { ...(emailLinks[idx] ?? { id: where.id }), ...data };
        if (idx >= 0) emailLinks[idx] = merged;
        return merged;
      }),
    },
  };
  return { tx, activities, invoiceLinks, outreachLinks, emailLinks };
}

function makeService(opts?: {
  contact?: Partial<ContactOpsPort>;
  accounting?: Partial<AccountingOpsPort>;
  outreach?: Partial<OutreachPort>;
  email?: Partial<EmailOpsPort>;
  meeting?: Partial<MeetingOpsPort>;
  project?: Partial<ProjectOpsPort>;
}) {
  const contact: ContactOpsPort = {
    getContact: jest.fn().mockResolvedValue(null),
    getContactSummaries: jest.fn().mockResolvedValue(new Map()),
    listContacts: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    getWorkspaceProjection: jest.fn().mockResolvedValue(null),
    ...(opts?.contact ?? {}),
  } as any;

  // Default AO port: DORMANT (degrade-clean). The Phase-3 invoice tests pass a
  // configured + entitled fake to exercise the federated path.
  const accounting: AccountingOpsPort = {
    isConfigured: jest.fn().mockReturnValue(false),
    checkEntitlement: jest
      .fn()
      .mockReturnValue({ allowed: false, mode: 'enforce', reason: 'unconfigured' }),
    createInvoice: jest.fn().mockResolvedValue(null),
    getInvoiceByRef: jest.fn().mockResolvedValue(null),
    getInvoiceById: jest.fn().mockResolvedValue(null),
    ...(opts?.accounting ?? {}),
  } as any;

  // Default Outreach port: DORMANT (degrade-clean). The Phase-4 outreach tests
  // pass a configured + entitled fake to exercise the federated path.
  const outreach: OutreachPort = {
    isConfigured: jest.fn().mockReturnValue(false),
    checkEntitlement: jest
      .fn()
      .mockReturnValue({ allowed: false, mode: 'enforce', reason: 'unconfigured' }),
    listCampaigns: jest.fn().mockResolvedValue([]),
    listTouchesForContact: jest.fn().mockResolvedValue([]),
    enrollContact: jest.fn().mockResolvedValue(null),
    scheduleSocialTouch: jest.fn().mockResolvedValue(null),
    ...(opts?.outreach ?? {}),
  } as any;

  // Default Email-Ops port: DORMANT (degrade-clean).
  const email: EmailOpsPort = {
    isConfigured: jest.fn().mockReturnValue(false),
    checkEntitlement: jest
      .fn()
      .mockReturnValue({ allowed: false, mode: 'enforce', reason: 'unconfigured' }),
    listThreadsWithContact: jest.fn().mockResolvedValue([]),
    listThreadMessages: jest.fn().mockResolvedValue([]),
    composeEmail: jest.fn().mockResolvedValue(null),
    ...(opts?.email ?? {}),
  } as any;

  // Default Meeting-Ops port: DORMANT (degrade-clean). The Phase-5 meeting test
  // passes a configured fake to exercise the federated meeting panel.
  const meeting: MeetingOpsPort = {
    isConfigured: jest.fn().mockReturnValue(false),
    listMeetingsForContact: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    listSummariesForContact: jest.fn().mockResolvedValue([]),
    listActionItemsForContact: jest.fn().mockResolvedValue([]),
    getMeetingSignal: jest.fn().mockResolvedValue({
      meetingCount: 0,
      lastMeetingAt: null,
      lastMeetingTitle: null,
      openActionItemCount: 0,
      latestSummaryHeadline: null,
    }),
    ...(opts?.meeting ?? {}),
  } as any;

  // Default Project-Ops port: DORMANT (degrade-clean). The projects-panel test
  // passes a configured fake to exercise the federated path.
  const project: ProjectOpsPort = {
    isConfigured: jest.fn().mockReturnValue(false),
    listProjectsForContact: jest.fn().mockResolvedValue([]),
    ...(opts?.project ?? {}),
  } as any;

  // WorkspaceContextService faked: runForUser invokes fn(tx) directly (the real
  // GUC/RLS is proven in the SQL acceptance, not re-mocked here); resolveAuthorized
  // returns the bootstrap workspace.
  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    assertAgentsNotPaused: jest.fn().mockResolvedValue(undefined),
    runForUser: jest.fn(async (_user: User, fn: any) => fn(lastTx.current)),
    runInWorkspace: jest.fn(async (_ws: string, _uc: any, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const svc = new CustomersService(
    workspaces,
    contact,
    accounting,
    outreach,
    email,
    meeting,
    project,
  );
  return { svc, contact, accounting, outreach, email, meeting, project, workspaces, lastTx };
}

describe('CustomersService — relationship logic', () => {
  describe('stage transitions', () => {
    it('advances LEAD → PROSPECT and logs a STAGE_CHANGE activity', async () => {
      const row = makeRow({ stage: RelationshipStage.LEAD });
      const { tx, activities } = makeTx(row);
      const { svc } = makeService();

      const updated = await svc.transitionInTx(tx, 'cust-1', RelationshipStage.PROSPECT, undefined, UC_UID);

      expect(updated.stage).toBe(RelationshipStage.PROSPECT);
      expect(tx.customer.update).toHaveBeenCalledTimes(1);
      // lastStageChangeAt is stamped on the update.
      expect(tx.customer.update.mock.calls[0][0].data).toHaveProperty('lastStageChangeAt');
      // Exactly one activity row, of kind STAGE_CHANGE, with from/to + actor.
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        kind: CustomerActivityKind.STAGE_CHANGE,
        fromStage: RelationshipStage.LEAD,
        toStage: RelationshipStage.PROSPECT,
        actorUcUid: UC_UID,
        workspaceId: WS,
      });
    });

    it('REJECTS LEAD → CUSTOMER (skip) and writes NO activity', async () => {
      const row = makeRow({ stage: RelationshipStage.LEAD });
      const { tx, activities } = makeTx(row);
      const { svc } = makeService();

      await expect(
        svc.transitionInTx(tx, 'cust-1', RelationshipStage.CUSTOMER, undefined, UC_UID),
      ).rejects.toThrow(BadRequestException);

      expect(tx.customer.update).not.toHaveBeenCalled();
      expect(activities).toHaveLength(0);
    });

    it('allows a backward move CUSTOMER → PROSPECT', async () => {
      const row = makeRow({ stage: RelationshipStage.CUSTOMER });
      const { tx, activities } = makeTx(row);
      const { svc } = makeService();

      const updated = await svc.transitionInTx(tx, 'cust-1', RelationshipStage.PROSPECT, 'churned', UC_UID);
      expect(updated.stage).toBe(RelationshipStage.PROSPECT);
      expect(activities[0].body).toBe('churned'); // caller note preserved
    });

    it('404s when the relationship does not exist', async () => {
      const { tx } = makeTx(null);
      tx.customer.findUnique.mockResolvedValue(null);
      const { svc } = makeService();
      await expect(
        svc.transitionInTx(tx, 'missing', RelationshipStage.PROSPECT, undefined, UC_UID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates a LEAD relationship + a CREATED activity, scoped to the GUC workspace', async () => {
      const { tx, activities } = makeTx(makeRow());
      const { svc } = makeService();

      const created = await svc.createInTx(
        tx,
        { contactId: 'contact-9', source: 'webform' },
        UC_UID,
      );

      // The insert carries the GUC workspaceId (RLS WITH CHECK satisfied).
      expect(tx.customer.create).toHaveBeenCalledTimes(1);
      expect(tx.customer.create.mock.calls[0][0].data.workspaceId).toBe(WS);
      expect(tx.customer.create.mock.calls[0][0].data.contactId).toBe('contact-9');
      expect(created.stage).toBe(RelationshipStage.LEAD);
      expect(activities[0]).toMatchObject({ kind: CustomerActivityKind.CREATED, workspaceId: WS });
    });

    it('rejects a duplicate (workspace, contact) relationship', async () => {
      const { tx } = makeTx(makeRow());
      tx.customer.findFirst.mockResolvedValue(makeRow()); // existing
      const { svc } = makeService();
      await expect(
        svc.createInTx(tx, { contactId: 'contact-1' }, UC_UID),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('mark lost / reopen', () => {
    it('marks lost (orthogonal to stage) + logs MARKED_LOST', async () => {
      const row = makeRow({ stage: RelationshipStage.PROSPECT, isLost: false });
      const { tx, activities } = makeTx(row);
      const { svc } = makeService();

      const updated = await svc.markLostInTx(tx, 'cust-1', 'went with a competitor', UC_UID);
      expect(updated.isLost).toBe(true);
      expect(updated.lostReason).toBe('went with a competitor');
      // Stage is unchanged — lost is orthogonal.
      expect(updated.stage).toBe(RelationshipStage.PROSPECT);
      expect(activities[0].kind).toBe(CustomerActivityKind.MARKED_LOST);
    });

    it('refuses to mark an already-lost relationship lost again', async () => {
      const row = makeRow({ isLost: true });
      const { tx } = makeTx(row);
      const { svc } = makeService();
      await expect(svc.markLostInTx(tx, 'cust-1', 'x', UC_UID)).rejects.toThrow(BadRequestException);
    });

    it('reopens a lost relationship + logs REOPENED', async () => {
      const row = makeRow({ isLost: true, lostReason: 'x', closedLostAt: new Date() });
      const { tx, activities } = makeTx(row);
      const { svc } = makeService();
      const updated = await svc.reopenInTx(tx, 'cust-1', UC_UID);
      expect(updated.isLost).toBe(false);
      expect(updated.lostReason).toBeNull();
      expect(activities[0].kind).toBe(CustomerActivityKind.REOPENED);
    });
  });

  describe('owner reassignment', () => {
    it('logs OWNER_CHANGED only when the owner actually changes', async () => {
      const row = makeRow({ ownerUserKey: 'old-owner' });
      const { tx, activities } = makeTx(row);
      const { svc } = makeService();

      await svc.updateInTx(tx, 'cust-1', { ownerUserKey: 'new-owner' }, UC_UID);
      expect(activities.some((a) => a.kind === CustomerActivityKind.OWNER_CHANGED)).toBe(true);

      // No-op owner write logs nothing.
      const { tx: tx2, activities: a2 } = makeTx(makeRow({ ownerUserKey: 'same' }));
      await svc.updateInTx(tx2, 'cust-1', { ownerUserKey: 'same' }, UC_UID);
      expect(a2.some((a) => a.kind === CustomerActivityKind.OWNER_CHANGED)).toBe(false);
    });
  });
});

describe('CustomersService — Contact-Ops federation (CO mocked)', () => {
  it('customer-360 stitches the LOCAL relationship with the FEDERATED contact + empty Phase-3 slots', async () => {
    const row = makeRow({ contactId: 'contact-42' });
    const getContact = jest.fn().mockResolvedValue({
      contactId: 'contact-42',
      displayName: 'Jane Lead',
      primaryEmail: 'jane@example.com',
      currentOrgId: null,
      currentOrgName: 'Acme',
      lastInteractionAt: null,
      communicationStrength: 0.8,
      tags: ['vip'],
      etag: 'W/"1"',
      vcardUid: 'vc-1',
      kind: 'individual',
      status: 'active',
      emails: [{ address: 'jane@example.com', is_primary: true }],
      phones: [],
      recentEvents: [],
    });
    const { svc, lastTx } = makeService({ contact: { getContact } });
    const { tx } = makeTx(row);
    lastTx.current = tx;

    const result = await svc.customer360ForUser(aaron, 'cust-1', WS);

    // The LOCAL relationship is present.
    expect(result.relationship.contactId).toBe('contact-42');
    // The contact is FEDERATED (mock), not copied from a local store.
    expect(getContact).toHaveBeenCalledWith(
      { workspaceId: WS, ucUid: UC_UID },
      'contact-42',
    );
    expect(result.contact?.displayName).toBe('Jane Lead');
    expect(result.contactFederation).toMatchObject({ resolved: true, source: 'contact-ops' });
    // Phase-3 invoice panel: AO dormant in this test → degrade-clean affordances.
    expect(result.invoices).toMatchObject({
      federated: false,
      source: 'accounting-ops',
      configured: false,
      entitled: false,
      canCreate: false,
      items: [],
    });
    // Phase-4 outreach + email panels: dormant → degrade-clean affordances.
    expect(result.outreach).toMatchObject({
      federated: false,
      source: 'outreach',
      configured: false,
      entitled: false,
      canStart: false,
      campaigns: [],
      touches: [],
      enrollments: [],
    });
    expect(result.email).toMatchObject({
      federated: false,
      source: 'email-ops',
      configured: false,
      entitled: false,
      canSend: false,
      threads: [],
      sent: [],
    });
    // Phase-5 Meeting-Ops panel: dormant in this test → degrade-clean (configured
    // false, empty lists), federated, never copied.
    expect(result.meetings).toMatchObject({
      federated: false,
      source: 'meeting-ops',
      configured: false,
      meetings: [],
      summaries: [],
      actionItems: [],
    });
  });

  it('customer-360 degrades cleanly when Contact-Ops returns nothing (dormant)', async () => {
    const row = makeRow({ contactId: 'contact-x' });
    const { svc, lastTx } = makeService({ contact: { getContact: jest.fn().mockResolvedValue(null) } });
    const { tx } = makeTx(row);
    lastTx.current = tx;

    const result = await svc.customer360ForUser(aaron, 'cust-1', WS);
    expect(result.contact).toBeNull();
    expect(result.contactFederation.resolved).toBe(false);
    // The relationship is still fully usable without the contact enrichment.
    expect(result.relationship.contactId).toBe('contact-x');
  });

  it('list join federates contact summaries onto rows (batched, not copied)', async () => {
    const rows = [makeRow({ id: 'c1', contactId: 'p1' }), makeRow({ id: 'c2', contactId: 'p2' })];
    const summaries = new Map([
      ['p1', { contactId: 'p1', displayName: 'Alice', primaryEmail: 'a@x.com', currentOrgId: null, currentOrgName: null, lastInteractionAt: null, communicationStrength: null, tags: [], etag: null }],
    ]);
    const getContactSummaries = jest.fn().mockResolvedValue(summaries);
    const { svc, lastTx } = makeService({ contact: { getContactSummaries } });
    const tx: any = {
      customer: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    lastTx.current = tx;

    const result = await svc.listForUser(aaron, { withContacts: true }, WS);

    expect(getContactSummaries).toHaveBeenCalledTimes(1);
    // p1 resolves to Alice; p2 has no federated summary -> contact:null placeholder.
    const c1 = result.items.find((i) => i.id === 'c1');
    const c2 = result.items.find((i) => i.id === 'c2');
    expect(c1?.contact?.displayName).toBe('Alice');
    expect(c2?.contact).toBeNull();
  });

  it('pipeline_board buckets non-lost relationships by stage with summed value', async () => {
    const rows = [
      makeRow({ id: 'l1', stage: RelationshipStage.LEAD, expectedValue: { toString: () => '100' } }),
      makeRow({ id: 'p1', stage: RelationshipStage.PROSPECT, expectedValue: { toString: () => '250' } }),
      makeRow({ id: 'p2', stage: RelationshipStage.PROSPECT, expectedValue: { toString: () => '50' } }),
    ];
    const { svc, lastTx } = makeService();
    const tx: any = { customer: { findMany: jest.fn().mockResolvedValue(rows) } };
    lastTx.current = tx;

    const board = await svc.pipelineForUser(aaron, WS, false);
    const lead = board.lanes.find((l) => l.stage === RelationshipStage.LEAD)!;
    const prospect = board.lanes.find((l) => l.stage === RelationshipStage.PROSPECT)!;
    const customer = board.lanes.find((l) => l.stage === RelationshipStage.CUSTOMER)!;

    expect(lead.count).toBe(1);
    expect(lead.expectedValue).toBe('100.00');
    expect(prospect.count).toBe(2);
    expect(prospect.expectedValue).toBe('300.00');
    expect(customer.count).toBe(0);
    expect(board.totals.count).toBe(3);
    expect(board.totals.expectedValue).toBe('400.00');
  });
});

describe('CustomersService — Accounting-Ops invoicing (Phase 3; AO mocked)', () => {
  const FED_INVOICE = {
    id: 'inv-1',
    invoiceNumber: 'INV-2026-0001',
    status: 'sent',
    currency: 'USD',
    subtotal: '2000.0000',
    taxTotal: '40.0000',
    total: '2040.0000',
    balanceDue: '2040.0000',
    issueDate: '2026-06-03',
    dueDate: '2026-07-01',
    externalSource: 'customer-ops',
    externalRef: 'cust:cust-1:fixed-key',
    pdfUrl: '/api/workspaces/ws/invoices/inv-1/pdf',
    hostedPayUrl: null,
  };

  const dto = {
    entityId: 'entity-1',
    customerName: 'Acme Co',
    customerEmail: 'ap@acme.test',
    lineItems: [{ description: 'Consulting', quantity: '10', unitPrice: '150.0000' }],
    currency: 'USD',
    dueDate: '2026-07-01',
    idempotencyKey: 'fixed-key',
  };

  function entitledAo(over: Partial<AccountingOpsPort> = {}): Partial<AccountingOpsPort> {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest
        .fn()
        .mockReturnValue({ allowed: true, mode: 'enforce', reason: 'entitled' }),
      createInvoice: jest.fn().mockResolvedValue(FED_INVOICE),
      getInvoiceByRef: jest.fn().mockResolvedValue(FED_INVOICE),
      getInvoiceById: jest.fn().mockResolvedValue(FED_INVOICE),
      ...over,
    };
  }

  describe('createInvoiceForUser', () => {
    it('gates on dual SKU, assembles a deterministic external_ref, calls AO, writes the link + activity', async () => {
      const { svc, accounting, lastTx } = makeService({ accounting: entitledAo() });
      const { tx, activities, invoiceLinks } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      const result = await svc.createInvoiceForUser(aaron, 'cust-1', dto, WS);

      // AO create called once with the assembled draft (deterministic ref).
      expect(accounting.createInvoice).toHaveBeenCalledTimes(1);
      const [ctx, draft] = (accounting.createInvoice as jest.Mock).mock.calls[0];
      expect(ctx).toMatchObject({ workspaceId: WS, ucUid: UC_UID });
      expect(draft.externalSource).toBe('customer-ops');
      expect(draft.externalRef).toBe('cust:cust-1:fixed-key'); // deterministic from idempotencyKey
      expect(draft.entityId).toBe('entity-1');
      expect(draft.customer).toMatchObject({ name: 'Acme Co', email: 'ap@acme.test' });
      // Money on the line stays a decimal string.
      expect(draft.lineItems[0]).toMatchObject({ unitPrice: '150.0000', quantity: '10' });

      // A link row was created (the thin local memory) carrying the tuple.
      expect(invoiceLinks).toHaveLength(1);
      expect(invoiceLinks[0]).toMatchObject({
        workspaceId: WS,
        customerId: 'cust-1',
        externalSource: 'customer-ops',
        externalRef: 'cust:cust-1:fixed-key',
        entityId: 'entity-1',
      });
      // The link's cached projection was refreshed from AO (status/total/aoInvoiceId).
      expect(invoiceLinks[0]).toMatchObject({ aoInvoiceId: 'inv-1', lastStatus: 'sent' });

      // An INVOICE_CREATED activity was logged.
      expect(activities.some((a) => a.kind === CustomerActivityKind.INVOICE_CREATED)).toBe(true);

      // The result surfaces the AO invoice + the serialized link.
      expect(result.invoice).toMatchObject({ id: 'inv-1', total: '2040.0000' });
      expect(result.link).toMatchObject({ externalRef: 'cust:cust-1:fixed-key', status: 'sent' });
    });

    it('IDEMPOTENT: the same idempotencyKey reuses the existing link (no second link row)', async () => {
      const { svc, lastTx } = makeService({ accounting: entitledAo() });
      const { tx, invoiceLinks } = makeTx(makeRow({ id: 'cust-1' }));
      // Pre-seed an existing link for the same (ws, source, ref) — findUnique hits it.
      const existing = {
        id: 'link-existing',
        workspaceId: WS,
        customerId: 'cust-1',
        externalSource: 'customer-ops',
        externalRef: 'cust:cust-1:fixed-key',
        entityId: 'entity-1',
        currency: 'USD',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      invoiceLinks.push(existing);
      tx.customerInvoiceLink.findUnique.mockResolvedValue(existing);
      lastTx.current = tx;

      await svc.createInvoiceForUser(aaron, 'cust-1', dto, WS);

      // No NEW link created — the existing one is reused (idempotent on the tuple).
      expect(tx.customerInvoiceLink.create).not.toHaveBeenCalled();
      // The existing link is refreshed in place.
      expect(tx.customerInvoiceLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'link-existing' } }),
      );
    });

    it('DENIES with 403 when the caller lacks the dual SKU — and makes NO AO call', async () => {
      const denyAo = entitledAo({
        checkEntitlement: jest
          .fn()
          .mockReturnValue({ allowed: false, mode: 'enforce', reason: 'not entitled' }),
      });
      const { svc, accounting, lastTx } = makeService({ accounting: denyAo });
      const { tx } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.createInvoiceForUser(aaron, 'cust-1', dto, WS)).rejects.toThrow(
        /not entitled/i,
      );
      expect(accounting.createInvoice).not.toHaveBeenCalled();
      expect(tx.customerInvoiceLink.create).not.toHaveBeenCalled();
    });

    it('DEGRADE-CLEAN: 400 + no AO call when Accounting-Ops is unconfigured', async () => {
      const unconfigured = entitledAo({ isConfigured: jest.fn().mockReturnValue(false) });
      const { svc, accounting, lastTx } = makeService({ accounting: unconfigured });
      const { tx } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.createInvoiceForUser(aaron, 'cust-1', dto, WS)).rejects.toThrow(
        /not connected/i,
      );
      expect(accounting.createInvoice).not.toHaveBeenCalled();
    });

    it('502 when AO is reachable+entitled but returns no invoice — the link still persists', async () => {
      const failAo = entitledAo({ createInvoice: jest.fn().mockResolvedValue(null) });
      const { svc, lastTx } = makeService({ accounting: failAo });
      const { tx, invoiceLinks } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.createInvoiceForUser(aaron, 'cust-1', dto, WS)).rejects.toThrow(
        /did not return an invoice/i,
      );
      // The link was recorded BEFORE the AO call, so the (source, ref) survives
      // for an idempotent retry.
      expect(invoiceLinks).toHaveLength(1);
      expect(invoiceLinks[0].externalRef).toBe('cust:cust-1:fixed-key');
    });

    it('404 when the relationship does not exist in the workspace', async () => {
      const { svc, lastTx } = makeService({ accounting: entitledAo() });
      const { tx } = makeTx(null);
      tx.customer.findUnique.mockResolvedValue(null);
      lastTx.current = tx;

      await expect(svc.createInvoiceForUser(aaron, 'missing', dto, WS)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('invoicesForUser / the customer-360 invoice panel', () => {
    it('polls AO for each link, refreshes the cache, and reports canCreate when entitled', async () => {
      const ao = entitledAo({
        getInvoiceById: jest
          .fn()
          .mockResolvedValue({ ...FED_INVOICE, status: 'paid', balanceDue: '0.0000' }),
      });
      const { svc, accounting, lastTx } = makeService({ accounting: ao });
      const { tx, invoiceLinks } = makeTx(makeRow({ id: 'cust-1' }));
      invoiceLinks.push({
        id: 'link-1',
        workspaceId: WS,
        customerId: 'cust-1',
        externalSource: 'customer-ops',
        externalRef: 'cust:cust-1:fixed-key',
        entityId: 'entity-1',
        aoInvoiceId: 'inv-1',
        currency: 'USD',
        lastStatus: 'sent',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.invoicesForUser(aaron, 'cust-1', WS);

      expect(panel).toMatchObject({
        federated: true,
        source: 'accounting-ops',
        configured: true,
        entitled: true,
        canCreate: true,
      });
      // Polled by AO id (the link already resolved it), and the cache refreshed.
      expect(accounting.getInvoiceById).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS }),
        'inv-1',
      );
      // Status reflects the poll; balanceDue is numerically 0 (the cached value
      // round-trips through Prisma.Decimal, which canonicalizes "0.0000"→"0";
      // the real NUMERIC(20,4) column preserves scale — proven in the RLS SQL).
      expect(panel.items[0].status).toBe('paid');
      expect(Number(panel.items[0].balanceDue)).toBe(0);
    });

    it('degrade-clean: when AO is unconfigured the panel reports configured:false and polls nothing', async () => {
      const { svc, accounting, lastTx } = makeService(); // default AO = dormant
      const { tx, invoiceLinks } = makeTx(makeRow({ id: 'cust-1' }));
      invoiceLinks.push({
        id: 'link-1',
        workspaceId: WS,
        customerId: 'cust-1',
        externalSource: 'customer-ops',
        externalRef: 'cust:cust-1:k',
        entityId: 'entity-1',
        currency: 'USD',
        lastStatus: 'draft',
        totalAmount: { toString: () => '100.0000' },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.invoicesForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ configured: false, entitled: false, canCreate: false });
      expect(accounting.getInvoiceByRef).not.toHaveBeenCalled();
      expect(accounting.getInvoiceById).not.toHaveBeenCalled();
      // The cached link history is still shown (never hidden by an AO outage).
      expect(panel.items[0]).toMatchObject({ status: 'draft', total: '100.0000' });
    });

    it('configured but NOT entitled: reads cached history, canCreate:false, still polls (viewer-level)', async () => {
      const ao = entitledAo({
        checkEntitlement: jest
          .fn()
          .mockReturnValue({ allowed: false, mode: 'enforce', reason: 'not entitled' }),
      });
      const { svc, accounting, lastTx } = makeService({ accounting: ao });
      const { tx, invoiceLinks } = makeTx(makeRow({ id: 'cust-1' }));
      invoiceLinks.push({
        id: 'link-1',
        workspaceId: WS,
        customerId: 'cust-1',
        externalSource: 'customer-ops',
        externalRef: 'cust:cust-1:k',
        entityId: 'entity-1',
        aoInvoiceId: 'inv-1',
        currency: 'USD',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.invoicesForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ configured: true, entitled: false, canCreate: false });
      // Reads are viewer-level on AO → still polled even though create is gated.
      expect(accounting.getInvoiceById).toHaveBeenCalledTimes(1);
    });
  });
});

describe('CustomersService — Outreach federation (Phase 4; Outreach app mocked)', () => {
  const ENROLLMENT_RESULT = {
    id: 'enr-1',
    channel: 'email',
    campaignId: 'camp-1',
    campaignName: 'June Nurture',
    status: 'queued',
    externalSource: 'customer-ops',
    externalRef: 'cust:cust-1:enroll:fixed-key',
    createdAt: '2026-06-03T00:00:00Z',
  };
  const CAMPAIGNS = [
    { id: 'camp-1', name: 'June Nurture', channel: 'email', status: 'running', isSequence: true, listId: 'lm-7', createdAt: null },
  ];
  const TOUCHES = [
    {
      id: 'touch-1',
      channel: 'email',
      campaignId: 'camp-1',
      campaignName: 'June Nurture',
      status: 'clicked',
      subject: 'Welcome',
      scheduledAt: null,
      sentAt: '2026-06-02T10:00:00Z',
      lastEngagementKind: 'clicked' as const,
      lastEngagementAt: '2026-06-02T11:00:00Z',
    },
  ];

  function entitledOutreach(over: Partial<OutreachPort> = {}): Partial<OutreachPort> {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: true, mode: 'enforce', reason: 'entitled' }),
      listCampaigns: jest.fn().mockResolvedValue(CAMPAIGNS),
      listTouchesForContact: jest.fn().mockResolvedValue(TOUCHES),
      enrollContact: jest.fn().mockResolvedValue(ENROLLMENT_RESULT),
      scheduleSocialTouch: jest.fn().mockResolvedValue({ ...ENROLLMENT_RESULT, id: 'enr-2', channel: 'social', campaignId: null }),
      ...over,
    };
  }

  const startDto = { campaignId: 'camp-1', contactEmail: 'jane@acme.test', idempotencyKey: 'fixed-key' };

  describe('outreachForUser (the 360 outreach panel)', () => {
    it('federates live campaigns + touches and reports canStart when entitled', async () => {
      const { svc, outreach, lastTx } = makeService({ outreach: entitledOutreach() });
      const { tx, outreachLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      outreachLinks.push({
        id: 'orl-1', workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42',
        channel: 'email', externalSource: 'customer-ops', externalRef: 'cust:cust-1:enroll:k',
        outreachId: 'enr-1', lastStatus: 'queued', createdAt: new Date(), updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.outreachForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ federated: true, source: 'outreach', configured: true, entitled: true, canStart: true });
      // Reads are federated from the Outreach app (never copied).
      expect(outreach.listCampaigns).toHaveBeenCalledTimes(1);
      expect(outreach.listTouchesForContact).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS }),
        'contact-42',
      );
      expect(panel.campaigns[0]).toMatchObject({ id: 'camp-1', isSequence: true });
      expect(panel.touches[0]).toMatchObject({ id: 'touch-1', lastEngagementKind: 'clicked' });
      // The local enrollment link memory is shown.
      expect(panel.enrollments[0]).toMatchObject({ externalRef: 'cust:cust-1:enroll:k', status: 'queued' });
    });

    it('degrade-clean: Outreach dormant → configured:false, polls nothing, still shows local links', async () => {
      const { svc, outreach, lastTx } = makeService(); // default outreach = dormant
      const { tx, outreachLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      outreachLinks.push({
        id: 'orl-1', workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42',
        channel: 'email', externalSource: 'customer-ops', externalRef: 'cust:cust-1:enroll:k',
        lastStatus: 'queued', createdAt: new Date(), updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.outreachForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ configured: false, entitled: false, canStart: false });
      expect(outreach.listCampaigns).not.toHaveBeenCalled();
      expect(outreach.listTouchesForContact).not.toHaveBeenCalled();
      expect(panel.enrollments[0]).toMatchObject({ status: 'queued' });
    });

    it('configured but NOT entitled: reads campaigns/touches (viewer-level), canStart:false', async () => {
      const outreachPort = entitledOutreach({
        checkEntitlement: jest.fn().mockReturnValue({ allowed: false, mode: 'enforce', reason: 'not entitled' }),
      });
      const { svc, outreach, lastTx } = makeService({ outreach: outreachPort });
      const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      const panel = await svc.outreachForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ configured: true, entitled: false, canStart: false });
      // Reads still happen (viewer-level) even though start is gated.
      expect(outreach.listCampaigns).toHaveBeenCalledTimes(1);
    });
  });

  describe('startCampaignForUser', () => {
    it('gates on dual SKU, deterministic external_ref, calls Outreach, writes link + activity', async () => {
      const { svc, outreach, lastTx } = makeService({ outreach: entitledOutreach() });
      const { tx, activities, outreachLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      const result = await svc.startCampaignForUser(aaron, 'cust-1', startDto, WS);

      expect(outreach.enrollContact).toHaveBeenCalledTimes(1);
      const [ctx, enrollment] = (outreach.enrollContact as jest.Mock).mock.calls[0];
      expect(ctx).toMatchObject({ workspaceId: WS, ucUid: UC_UID, entitlements: expect.any(Array) });
      expect(enrollment.externalSource).toBe('customer-ops');
      expect(enrollment.externalRef).toBe('cust:cust-1:enroll:fixed-key');
      // contactId travels as a thin reference (never a copy).
      expect(enrollment.contactId).toBe('contact-42');

      // A link row was created carrying the tuple, refreshed from the app.
      expect(outreachLinks).toHaveLength(1);
      expect(outreachLinks[0]).toMatchObject({
        workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42',
        channel: 'email', externalRef: 'cust:cust-1:enroll:fixed-key', outreachId: 'enr-1', lastStatus: 'queued',
      });
      // A CAMPAIGN_STARTED activity was logged.
      expect(activities.some((a) => a.kind === CustomerActivityKind.CAMPAIGN_STARTED)).toBe(true);
      expect(result.enrollment).toMatchObject({ id: 'enr-1', status: 'queued' });
      expect(result.link).toMatchObject({ externalRef: 'cust:cust-1:enroll:fixed-key', status: 'queued' });
    });

    it('IDEMPOTENT: the same idempotencyKey reuses the existing link (no second link row)', async () => {
      const { svc, lastTx } = makeService({ outreach: entitledOutreach() });
      const { tx, outreachLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      const existing = {
        id: 'orl-existing', workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42',
        channel: 'email', externalSource: 'customer-ops', externalRef: 'cust:cust-1:enroll:fixed-key',
        createdAt: new Date(), updatedAt: new Date(),
      };
      outreachLinks.push(existing);
      tx.customerOutreachLink.findUnique.mockResolvedValue(existing);
      lastTx.current = tx;

      await svc.startCampaignForUser(aaron, 'cust-1', startDto, WS);
      expect(tx.customerOutreachLink.create).not.toHaveBeenCalled();
      expect(tx.customerOutreachLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'orl-existing' } }),
      );
    });

    it('DENIES with 403 when the caller lacks the dual SKU — and makes NO Outreach call', async () => {
      const denyOutreach = entitledOutreach({
        checkEntitlement: jest.fn().mockReturnValue({ allowed: false, mode: 'enforce', reason: 'not entitled' }),
      });
      const { svc, outreach, lastTx } = makeService({ outreach: denyOutreach });
      const { tx } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.startCampaignForUser(aaron, 'cust-1', startDto, WS)).rejects.toThrow(/not entitled/i);
      expect(outreach.enrollContact).not.toHaveBeenCalled();
      expect(tx.customerOutreachLink.create).not.toHaveBeenCalled();
    });

    it('DEGRADE-CLEAN: 400 + no Outreach call when unconfigured', async () => {
      const unconfigured = entitledOutreach({ isConfigured: jest.fn().mockReturnValue(false) });
      const { svc, outreach, lastTx } = makeService({ outreach: unconfigured });
      const { tx } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.startCampaignForUser(aaron, 'cust-1', startDto, WS)).rejects.toThrow(/not connected/i);
      expect(outreach.enrollContact).not.toHaveBeenCalled();
    });

    it('502 when Outreach is reachable+entitled but returns nothing — the link still persists', async () => {
      const failOutreach = entitledOutreach({ enrollContact: jest.fn().mockResolvedValue(null) });
      const { svc, lastTx } = makeService({ outreach: failOutreach });
      const { tx, outreachLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      await expect(svc.startCampaignForUser(aaron, 'cust-1', startDto, WS)).rejects.toThrow(/did not return an enrollment/i);
      expect(outreachLinks).toHaveLength(1);
      expect(outreachLinks[0].externalRef).toBe('cust:cust-1:enroll:fixed-key');
    });

    it('scheduleSocialTouchForUser enrolls a Postiz touch with a social external_ref', async () => {
      const { svc, outreach, lastTx } = makeService({ outreach: entitledOutreach() });
      const { tx, outreachLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      const result = await svc.scheduleSocialTouchForUser(
        aaron, 'cust-1', { channelId: 'postiz-li-1', body: 'Hi Jane', idempotencyKey: 'soc-1' }, WS,
      );
      const [, req] = (outreach.scheduleSocialTouch as jest.Mock).mock.calls[0];
      expect(req.externalRef).toBe('cust:cust-1:social:soc-1');
      expect(req.channelId).toBe('postiz-li-1');
      expect(outreachLinks[0]).toMatchObject({ channel: 'social', externalRef: 'cust:cust-1:social:soc-1' });
      expect(result.enrollment).toMatchObject({ id: 'enr-2', channel: 'social' });
    });
  });
});

describe('CustomersService — Email-Ops federation (Phase 4; Email-Ops app mocked)', () => {
  const COMPOSE_RESULT = {
    id: 'msg-1', threadId: 'thread-1', status: 'queued', mode: 'send',
    externalSource: 'customer-ops', externalRef: 'cust:cust-1:email:fixed-key', createdAt: '2026-06-03T00:00:00Z',
  };
  const THREADS = [
    {
      id: 'thread-1', subject: 'Proposal', messageCount: 3, unread: true,
      lastMessageAt: '2026-06-02T10:00:00Z', lastSnippet: 'Looks good…',
      participants: [{ address: 'jane@acme.test', name: 'Jane Lead' }],
    },
  ];

  function entitledEmail(over: Partial<EmailOpsPort> = {}): Partial<EmailOpsPort> {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: true, mode: 'enforce', reason: 'entitled' }),
      listThreadsWithContact: jest.fn().mockResolvedValue(THREADS),
      listThreadMessages: jest.fn().mockResolvedValue([]),
      composeEmail: jest.fn().mockResolvedValue(COMPOSE_RESULT),
      ...over,
    };
  }

  const sendDto = { toAddress: 'jane@acme.test', subject: 'Following up', body: 'Hi Jane', idempotencyKey: 'fixed-key' };

  describe('emailForUser (the 360 email panel)', () => {
    it('federates live mailbox threads and reports canSend when entitled', async () => {
      const { svc, email, lastTx } = makeService({ email: entitledEmail() });
      const { tx, emailLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      emailLinks.push({
        id: 'eml-1', workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42', mode: 'send',
        externalSource: 'customer-ops', externalRef: 'cust:cust-1:email:k', messageId: 'msg-1',
        subject: 'Hi', lastStatus: 'sent', createdAt: new Date(), updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.emailForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ federated: true, source: 'email-ops', configured: true, entitled: true, canSend: true });
      expect(email.listThreadsWithContact).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS }),
        'contact-42',
      );
      expect(panel.threads[0]).toMatchObject({ id: 'thread-1', unread: true });
      expect(panel.sent[0]).toMatchObject({ externalRef: 'cust:cust-1:email:k', status: 'sent' });
    });

    it('degrade-clean: Email-Ops dormant → configured:false, polls nothing, still shows local links', async () => {
      const { svc, email, lastTx } = makeService(); // default email = dormant
      const { tx, emailLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      emailLinks.push({
        id: 'eml-1', workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42', mode: 'draft',
        externalSource: 'customer-ops', externalRef: 'cust:cust-1:email:k', subject: 'Hi',
        lastStatus: 'pending_approval', createdAt: new Date(), updatedAt: new Date(),
      });
      lastTx.current = tx;

      const panel = await svc.emailForUser(aaron, 'cust-1', WS);
      expect(panel).toMatchObject({ configured: false, entitled: false, canSend: false });
      expect(email.listThreadsWithContact).not.toHaveBeenCalled();
      expect(panel.sent[0]).toMatchObject({ status: 'pending_approval', mode: 'draft' });
    });
  });

  describe('sendEmailForUser', () => {
    it('SEND: gates on dual SKU, deterministic external_ref, calls Email-Ops, writes link + activity', async () => {
      const { svc, email, lastTx } = makeService({ email: entitledEmail() });
      const { tx, activities, emailLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      // mode is explicit here — the default is now 'draft' (see the safe-default test below).
      const result = await svc.sendEmailForUser(aaron, 'cust-1', { ...sendDto, mode: 'send' }, WS);

      expect(email.composeEmail).toHaveBeenCalledTimes(1);
      const [ctx, req] = (email.composeEmail as jest.Mock).mock.calls[0];
      expect(ctx).toMatchObject({ workspaceId: WS, ucUid: UC_UID, entitlements: expect.any(Array) });
      expect(req.externalSource).toBe('customer-ops');
      expect(req.externalRef).toBe('cust:cust-1:email:fixed-key');
      expect(req.mode).toBe('send');
      expect(req.toAddress).toBe('jane@acme.test');
      expect(req.contactId).toBe('contact-42'); // thin reference, never a copy

      expect(emailLinks).toHaveLength(1);
      expect(emailLinks[0]).toMatchObject({
        workspaceId: WS, customerId: 'cust-1', contactId: 'contact-42', mode: 'send',
        externalRef: 'cust:cust-1:email:fixed-key', messageId: 'msg-1', lastStatus: 'queued',
      });
      expect(activities.some((a) => a.kind === CustomerActivityKind.EMAIL_SENT)).toBe(true);
      expect(result.message).toMatchObject({ id: 'msg-1', status: 'queued' });
      expect(result.link).toMatchObject({ externalRef: 'cust:cust-1:email:fixed-key', status: 'queued' });
    });

    it('DRAFT mode stages the message (mode=draft on the wire + the link)', async () => {
      const draftEmail = entitledEmail({
        composeEmail: jest.fn().mockResolvedValue({ ...COMPOSE_RESULT, id: 'msg-2', status: 'pending_approval', mode: 'draft' }),
      });
      const { svc, email, lastTx } = makeService({ email: draftEmail });
      const { tx, emailLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      await svc.sendEmailForUser(aaron, 'cust-1', { ...sendDto, mode: 'draft', idempotencyKey: 'draft-1' }, WS);
      const [, req] = (email.composeEmail as jest.Mock).mock.calls[0];
      expect(req.mode).toBe('draft');
      expect(emailLinks[0]).toMatchObject({ mode: 'draft', lastStatus: 'pending_approval' });
    });

    it('SAFE DEFAULT: mode omitted → DRAFTS (stages for approval, does NOT send)', async () => {
      const draftEmail = entitledEmail({
        composeEmail: jest.fn().mockResolvedValue({ ...COMPOSE_RESULT, id: 'msg-3', status: 'pending_approval', mode: 'draft' }),
      });
      const { svc, email, workspaces, lastTx } = makeService({ email: draftEmail });
      const { tx, emailLinks } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      // No `mode` on the dto — the send default must resolve to 'draft'.
      await svc.sendEmailForUser(aaron, 'cust-1', sendDto, WS);
      const [, req] = (email.composeEmail as jest.Mock).mock.calls[0];
      expect(req.mode).toBe('draft');
      expect(emailLinks[0]).toMatchObject({ mode: 'draft', lastStatus: 'pending_approval' });
      // A draft is NOT gated by the outbound kill switch (only mode=send is).
      expect(workspaces.assertAgentsNotPaused).not.toHaveBeenCalled();
    });

    it('KILL SWITCH: workspace paused → mode=send is HALTED (403), NO Email-Ops call, no link write', async () => {
      const { svc, email, workspaces, lastTx } = makeService({ email: entitledEmail() });
      const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;
      // Runtime, workspace-scoped kill switch engaged for this workspace.
      (workspaces.assertAgentsNotPaused as jest.Mock).mockRejectedValue(
        new ForbiddenException('Agent and outbound activity is paused for this workspace.'),
      );

      await expect(
        svc.sendEmailForUser(aaron, 'cust-1', { ...sendDto, mode: 'send' }, WS),
      ).rejects.toThrow(/paused/i);

      expect(workspaces.assertAgentsNotPaused).toHaveBeenCalledWith(WS);
      expect(email.composeEmail).not.toHaveBeenCalled();
      expect(tx.customerEmailLink.create).not.toHaveBeenCalled();
    });

    it('KILL SWITCH: workspace NOT paused → mode=send proceeds and calls Email-Ops', async () => {
      const { svc, email, workspaces, lastTx } = makeService({ email: entitledEmail() });
      const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      await svc.sendEmailForUser(aaron, 'cust-1', { ...sendDto, mode: 'send' }, WS);

      expect(workspaces.assertAgentsNotPaused).toHaveBeenCalledWith(WS);
      expect(email.composeEmail).toHaveBeenCalledTimes(1);
    });

    it('falls back to the FEDERATED contact primary email when toAddress is omitted', async () => {
      const getContact = jest.fn().mockResolvedValue({
        contactId: 'contact-42', displayName: 'Jane', primaryEmail: 'jane@fed.test',
        currentOrgId: null, currentOrgName: null, lastInteractionAt: null, communicationStrength: null,
        tags: [], etag: null, vcardUid: null, kind: 'individual', status: 'active', emails: [], phones: [], recentEvents: [],
      });
      const { svc, email, lastTx } = makeService({ email: entitledEmail(), contact: { getContact } });
      const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      await svc.sendEmailForUser(aaron, 'cust-1', { subject: 'Hi', body: 'b', idempotencyKey: 'k2' }, WS);
      expect(getContact).toHaveBeenCalled(); // the address was federated, not stored
      const [, req] = (email.composeEmail as jest.Mock).mock.calls[0];
      expect(req.toAddress).toBe('jane@fed.test');
    });

    it('400 when no toAddress and the federated contact has no primary email', async () => {
      const getContact = jest.fn().mockResolvedValue(null); // CO dormant / no email
      const { svc, email, lastTx } = makeService({ email: entitledEmail(), contact: { getContact } });
      const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
      lastTx.current = tx;

      await expect(
        svc.sendEmailForUser(aaron, 'cust-1', { subject: 'Hi', body: 'b' }, WS),
      ).rejects.toThrow(/no recipient address/i);
      expect(email.composeEmail).not.toHaveBeenCalled();
    });

    it('DENIES with 403 when the caller lacks the dual SKU — and makes NO Email-Ops call', async () => {
      const denyEmail = entitledEmail({
        checkEntitlement: jest.fn().mockReturnValue({ allowed: false, mode: 'enforce', reason: 'not entitled' }),
      });
      const { svc, email, lastTx } = makeService({ email: denyEmail });
      const { tx } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.sendEmailForUser(aaron, 'cust-1', sendDto, WS)).rejects.toThrow(/not entitled/i);
      expect(email.composeEmail).not.toHaveBeenCalled();
      expect(tx.customerEmailLink.create).not.toHaveBeenCalled();
    });

    it('DEGRADE-CLEAN: 400 + no Email-Ops call when unconfigured', async () => {
      const unconfigured = entitledEmail({ isConfigured: jest.fn().mockReturnValue(false) });
      const { svc, email, lastTx } = makeService({ email: unconfigured });
      const { tx } = makeTx(makeRow({ id: 'cust-1' }));
      lastTx.current = tx;

      await expect(svc.sendEmailForUser(aaron, 'cust-1', sendDto, WS)).rejects.toThrow(/not connected/i);
      expect(email.composeEmail).not.toHaveBeenCalled();
    });
  });
});

describe('CustomersService — Meeting-Ops federation (Phase 5; Meeting-Ops app mocked)', () => {
  const MEETINGS = {
    items: [
      {
        id: 'mtg-1',
        title: 'Discovery call',
        startedAt: '2026-06-01T15:00:00Z',
        endedAt: '2026-06-01T15:45:00Z',
        durationSeconds: 2700,
        status: 'summarized',
        hasSummary: true,
        actionItemCount: 2,
        participants: [{ contactId: 'contact-42', displayName: 'Jane Lead', email: 'jane@x.com' }],
      },
    ],
    count: 1,
    nextCursor: null,
  };
  const SUMMARIES = [
    { id: 'sum-1', meetingId: 'mtg-1', headline: 'Wants enterprise', body: 'recap…', keyPoints: ['enterprise'], createdAt: '2026-06-01T16:00:00Z' },
  ];
  const ACTION_ITEMS = [
    { id: 'ai-1', meetingId: 'mtg-1', text: 'Send quote', status: 'open', assigneeContactId: null, assigneeLabel: 'Aaron', dueAt: '2026-06-05', projectOpsTaskId: 'task-789', createdAt: '2026-06-01T16:00:00Z' },
  ];

  function configuredMeeting(over: Partial<MeetingOpsPort> = {}): Partial<MeetingOpsPort> {
    return {
      isConfigured: jest.fn().mockReturnValue(true),
      listMeetingsForContact: jest.fn().mockResolvedValue(MEETINGS),
      listSummariesForContact: jest.fn().mockResolvedValue(SUMMARIES),
      listActionItemsForContact: jest.fn().mockResolvedValue(ACTION_ITEMS),
      getMeetingSignal: jest.fn().mockResolvedValue({
        meetingCount: 1, lastMeetingAt: '2026-06-01T15:00:00Z', lastMeetingTitle: 'Discovery call',
        openActionItemCount: 1, latestSummaryHeadline: 'Wants enterprise',
      }),
      ...over,
    };
  }

  it('meetingsForUser federates meetings + summaries + action items (never copied), surfacing the bridge task id', async () => {
    const { svc, meeting, lastTx } = makeService({ meeting: configuredMeeting() });
    const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
    lastTx.current = tx;

    const panel = await svc.meetingsForUser(aaron, 'cust-1', WS);

    expect(panel).toMatchObject({ federated: true, source: 'meeting-ops', configured: true });
    expect(meeting.listMeetingsForContact).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      'contact-42',
      expect.any(Object),
    );
    expect(panel.meetings[0]).toMatchObject({ id: 'mtg-1', hasSummary: true });
    expect(panel.summaries[0]).toMatchObject({ id: 'sum-1', headline: 'Wants enterprise' });
    // The action item SURFACES the Project-Ops bridge task id (we never write it).
    expect(panel.actionItems[0]).toMatchObject({ id: 'ai-1', projectOpsTaskId: 'task-789' });
  });

  it('degrade-clean: Meeting-Ops dormant → configured:false, federates nothing', async () => {
    const { svc, meeting, lastTx } = makeService(); // default meeting = dormant
    const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
    lastTx.current = tx;

    const panel = await svc.meetingsForUser(aaron, 'cust-1', WS);
    expect(panel).toMatchObject({ federated: false, configured: false, meetings: [], summaries: [], actionItems: [] });
    expect(meeting.listMeetingsForContact).not.toHaveBeenCalled();
  });

  it('the customer-360 meeting slot is now FEDERATED (filled from Meeting-Ops)', async () => {
    const { svc, lastTx } = makeService({ meeting: configuredMeeting() });
    const { tx } = makeTx(makeRow({ id: 'cust-1', contactId: 'contact-42' }));
    lastTx.current = tx;

    const result = await svc.customer360ForUser(aaron, 'cust-1', WS);
    expect(result.meetings).toMatchObject({ federated: true, configured: true });
    expect(result.meetings.meetings[0]).toMatchObject({ id: 'mtg-1' });
  });
});

describe('CustomersService — the engagement → funnel-stage hook (Phase 4)', () => {
  it('a REPLY advances LEAD → PROSPECT and logs STAGE_CHANGE + ENGAGEMENT_ADVANCED', async () => {
    const row = makeRow({ stage: RelationshipStage.LEAD });
    const { tx, activities } = makeTx(row);
    const { svc } = makeService();

    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'replied', source: 'email-ops' }, UC_UID);

    expect(out.advanced).toBe(true);
    expect(out.toStage).toBe(RelationshipStage.PROSPECT);
    expect(tx.customer.update).toHaveBeenCalledTimes(1);
    expect(tx.customer.update.mock.calls[0][0].data).toMatchObject({ stage: RelationshipStage.PROSPECT });
    // BOTH a STAGE_CHANGE (from/to) and an ENGAGEMENT_ADVANCED row in the same tx.
    expect(activities.some((a) => a.kind === CustomerActivityKind.STAGE_CHANGE && a.toStage === 'PROSPECT')).toBe(true);
    expect(activities.some((a) => a.kind === CustomerActivityKind.ENGAGEMENT_ADVANCED)).toBe(true);
  });

  it('a CLICK advances PROSPECT → CUSTOMER', async () => {
    const row = makeRow({ stage: RelationshipStage.PROSPECT });
    const { tx } = makeTx(row);
    const { svc } = makeService();
    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'clicked', source: 'outreach' }, UC_UID);
    expect(out.advanced).toBe(true);
    expect(out.toStage).toBe(RelationshipStage.CUSTOMER);
  });

  it('an OPEN is recorded but does NOT advance (weak intent)', async () => {
    const row = makeRow({ stage: RelationshipStage.LEAD });
    const { tx, activities } = makeTx(row);
    const { svc } = makeService();
    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'opened' }, UC_UID);
    expect(out.advanced).toBe(false);
    expect(tx.customer.update).not.toHaveBeenCalled();
    // Still logged as engagement provenance (no stage write).
    expect(activities).toHaveLength(1);
    expect(activities[0].kind).toBe(CustomerActivityKind.ENGAGEMENT_ADVANCED);
  });

  it('a BOUNCE never advances (data-quality signal), only logs', async () => {
    const row = makeRow({ stage: RelationshipStage.LEAD });
    const { tx, activities } = makeTx(row);
    const { svc } = makeService();
    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'bounced', source: 'email-ops' }, UC_UID);
    expect(out.advanced).toBe(false);
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(activities[0].kind).toBe(CustomerActivityKind.ENGAGEMENT_ADVANCED);
  });

  it('does NOT advance past the top of the funnel (CUSTOMER stays CUSTOMER on a reply)', async () => {
    const row = makeRow({ stage: RelationshipStage.CUSTOMER });
    const { tx } = makeTx(row);
    const { svc } = makeService();
    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'replied' }, UC_UID);
    expect(out.advanced).toBe(false);
    expect(tx.customer.update).not.toHaveBeenCalled();
  });

  it('does NOT advance a LOST relationship on a reply (re-open first)', async () => {
    const row = makeRow({ stage: RelationshipStage.PROSPECT, isLost: true });
    const { tx } = makeTx(row);
    const { svc } = makeService();
    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'replied' }, UC_UID);
    expect(out.advanced).toBe(false);
    expect(tx.customer.update).not.toHaveBeenCalled();
    expect(out.reason).toMatch(/closed-lost/i);
  });

  it('the advance is exactly ONE step (never skips qualification: LEAD reply → PROSPECT, not CUSTOMER)', async () => {
    const row = makeRow({ stage: RelationshipStage.LEAD });
    const { tx } = makeTx(row);
    const { svc } = makeService();
    const out = await svc.recordEngagementInTx(tx, 'cust-1', { kind: 'replied' }, UC_UID);
    expect(out.toStage).toBe(RelationshipStage.PROSPECT); // NOT CUSTOMER
  });

  it('404s when the relationship does not exist', async () => {
    const { tx } = makeTx(null);
    tx.customer.findUnique.mockResolvedValue(null);
    const { svc } = makeService();
    await expect(
      svc.recordEngagementInTx(tx, 'missing', { kind: 'replied' }, UC_UID),
    ).rejects.toThrow(NotFoundException);
  });
});

// ============================================================================
// Phase 7 — the *ForUser audit side-effects (the append-only trail).
//
// Every relationship WRITE entry point records exactly one audit event AFTER the
// RLS write commits, with the ALREADY-RESOLVED workspaceId (so the audit row's
// workspace matches the write's GUC WITH CHECK) and the acting ucUid. These pin
// each write path's (action, resource, details) — including the engagement
// consistency fix that just landed (recordEngagementForUser now audits the same
// state change /transition does, with advanced + the toStage when it advances).
//
// The audit dep is @Optional() and sits in the 10th constructor slot (after the
// @Optional leadLabels + graphIngest). The existing makeService() omits all three
// trailing deps — that 7-arg construction is left untouched, which proves the
// `this.audit?.log(...)` path no-ops cleanly when the audit module is absent.
// ============================================================================
describe('CustomersService — *ForUser audit side-effects (Phase 7; AuditService mocked)', () => {
  /** Build the service with a mock AuditService injected in the trailing
   *  @Optional() position (workspaces, contact, accounting, outreach, email,
   *  meeting, project, leadLabels?, graphIngest?, audit?). */
  function makeAuditedService(opts?: { contact?: Partial<ContactOpsPort> }) {
    const contact: ContactOpsPort = {
      getContact: jest.fn().mockResolvedValue(null),
      getContactSummaries: jest.fn().mockResolvedValue(new Map()),
      listContacts: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
      getWorkspaceProjection: jest.fn().mockResolvedValue(null),
      ...(opts?.contact ?? {}),
    } as any;
    const dormant = {
      isConfigured: jest.fn().mockReturnValue(false),
      checkEntitlement: jest.fn().mockReturnValue({ allowed: false, mode: 'enforce', reason: 'x' }),
    };
    const accounting = { ...dormant } as unknown as AccountingOpsPort;
    const outreach = { ...dormant } as unknown as OutreachPort;
    const email = { ...dormant } as unknown as EmailOpsPort;
    const meeting = { isConfigured: jest.fn().mockReturnValue(false) } as unknown as MeetingOpsPort;
    const project = { isConfigured: jest.fn().mockReturnValue(false) } as unknown as ProjectOpsPort;

    const lastTx = { current: null as any };
    const workspaces = {
      resolveAuthorized: jest.fn().mockResolvedValue(WS),
      runForUser: jest.fn(async (_user: User, fn: any) => fn(lastTx.current)),
      runInWorkspace: jest.fn(async (_ws: string, _uc: any, fn: any) => fn(lastTx.current)),
    } as unknown as WorkspaceContextService;

    const audit = { log: jest.fn().mockResolvedValue(null) } as unknown as AuditService;

    const svc = new CustomersService(
      workspaces,
      contact,
      accounting,
      outreach,
      email,
      meeting,
      project,
      undefined, // leadLabels (@Optional)
      undefined, // graphIngest (@Optional)
      audit, // @Optional, 10th slot
    );
    return { svc, audit, lastTx, workspaces };
  }

  it('createForUser → audit CREATE / customer / {contactId, stage} with the resolved workspace + actor', async () => {
    const { svc, audit, lastTx } = makeAuditedService();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    const created = await svc.createForUser(aaron, { contactId: 'contact-9', source: 'webform' }, WS);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        userId: UC_UID,
        action: AuditAction.CREATE,
        resource: 'customer',
        resourceId: created.id,
        details: { contactId: 'contact-9', stage: RelationshipStage.LEAD },
      }),
    );
  });

  it('updateForUser → audit UPDATE / customer / {fields:[...]} listing the patched keys', async () => {
    const { svc, audit, lastTx } = makeAuditedService();
    const { tx } = makeTx(makeRow({ ownerUserKey: 'old' }));
    lastTx.current = tx;

    await svc.updateForUser(aaron, 'cust-1', { ownerUserKey: 'new', notes: 'hi' }, WS);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const dto = (audit.log as jest.Mock).mock.calls[0][0];
    expect(dto).toMatchObject({
      workspaceId: WS,
      userId: UC_UID,
      action: AuditAction.UPDATE,
      resource: 'customer',
      resourceId: 'cust-1',
    });
    // The details enumerate exactly the DTO keys that were sent.
    expect(dto.details.fields).toEqual(expect.arrayContaining(['ownerUserKey', 'notes']));
    expect(dto.details.fields).toHaveLength(2);
  });

  it('transitionForUser → audit UPDATE / customer / {kind:transition, toStage}', async () => {
    const { svc, audit, lastTx } = makeAuditedService();
    const { tx } = makeTx(makeRow({ stage: RelationshipStage.LEAD }));
    lastTx.current = tx;

    await svc.transitionForUser(aaron, 'cust-1', { toStage: RelationshipStage.PROSPECT }, WS);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        action: AuditAction.UPDATE,
        resource: 'customer',
        resourceId: 'cust-1',
        details: { kind: 'transition', toStage: RelationshipStage.PROSPECT },
      }),
    );
  });

  it('markLostForUser → audit UPDATE / customer / {kind:mark_lost}', async () => {
    const { svc, audit, lastTx } = makeAuditedService();
    const { tx } = makeTx(makeRow({ stage: RelationshipStage.PROSPECT, isLost: false }));
    lastTx.current = tx;

    await svc.markLostForUser(aaron, 'cust-1', { reason: 'lost to a competitor' }, WS);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        resource: 'customer',
        resourceId: 'cust-1',
        details: { kind: 'mark_lost' },
      }),
    );
  });

  it('reopenForUser → audit UPDATE / customer / {kind:reopen}', async () => {
    const { svc, audit, lastTx } = makeAuditedService();
    const { tx } = makeTx(makeRow({ isLost: true, lostReason: 'x', closedLostAt: new Date() }));
    lastTx.current = tx;

    await svc.reopenForUser(aaron, 'cust-1', WS);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        resource: 'customer',
        resourceId: 'cust-1',
        details: { kind: 'reopen' },
      }),
    );
  });

  it('addNoteForUser → audit CREATE / customer_note (a distinct resource)', async () => {
    const { svc, audit, lastTx } = makeAuditedService();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    await svc.addNoteForUser(aaron, 'cust-1', { body: 'left a voicemail' }, WS);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        resource: 'customer_note',
        resourceId: 'cust-1',
        details: { kind: 'note' },
      }),
    );
  });

  describe('recordEngagementForUser — the consistency fix (advancing vs non-advancing)', () => {
    it('an ADVANCING signal (replied on a LEAD) → details {kind:engagement, signal, advanced:true, toStage}', async () => {
      const { svc, audit, lastTx } = makeAuditedService();
      const { tx } = makeTx(makeRow({ stage: RelationshipStage.LEAD }));
      lastTx.current = tx;

      const out = await svc.recordEngagementForUser(
        aaron,
        'cust-1',
        { kind: 'replied', source: 'email-ops' },
        WS,
      );
      expect(out.advanced).toBe(true);

      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WS,
          userId: UC_UID,
          action: AuditAction.UPDATE,
          resource: 'customer',
          resourceId: 'cust-1',
          // The advancing branch carries the toStage so the audit matches the
          // /transition row for the same state change.
          details: {
            kind: 'engagement',
            signal: 'replied',
            advanced: true,
            toStage: RelationshipStage.PROSPECT,
          },
        }),
      );
    });

    it('a NON-advancing signal (opened) → details {kind:engagement, signal, advanced:false} with NO toStage key', async () => {
      const { svc, audit, lastTx } = makeAuditedService();
      const { tx } = makeTx(makeRow({ stage: RelationshipStage.LEAD }));
      lastTx.current = tx;

      const out = await svc.recordEngagementForUser(aaron, 'cust-1', { kind: 'opened' }, WS);
      expect(out.advanced).toBe(false);

      expect(audit.log).toHaveBeenCalledTimes(1);
      const dto = (audit.log as jest.Mock).mock.calls[0][0];
      expect(dto.details).toEqual({ kind: 'engagement', signal: 'opened', advanced: false });
      // No stage moved → the toStage key is omitted entirely (not undefined/null).
      expect('toStage' in dto.details).toBe(false);
    });

    it('a BOUNCE never advances → advanced:false, no toStage', async () => {
      const { svc, audit, lastTx } = makeAuditedService();
      const { tx } = makeTx(makeRow({ stage: RelationshipStage.LEAD }));
      lastTx.current = tx;

      await svc.recordEngagementForUser(aaron, 'cust-1', { kind: 'bounced', source: 'email-ops' }, WS);
      const dto = (audit.log as jest.Mock).mock.calls[0][0];
      expect(dto.details).toMatchObject({ kind: 'engagement', signal: 'bounced', advanced: false });
      expect('toStage' in dto.details).toBe(false);
    });
  });

  it('every write resolves the workspace exactly once and passes THAT id to audit.log', async () => {
    // Pin the load-bearing invariant: the audited workspaceId is the resolved one
    // (so the audit row lands under the same GUC the write committed in), not a
    // raw requested id.
    const { svc, audit, lastTx, workspaces } = makeAuditedService();
    const { tx } = makeTx(makeRow());
    lastTx.current = tx;

    await svc.createForUser(aaron, { contactId: 'contact-9' }, 'requested-but-overridden');
    expect(workspaces.resolveAuthorized).toHaveBeenCalledTimes(1);
    expect((audit.log as jest.Mock).mock.calls[0][0].workspaceId).toBe(WS);
  });
});
