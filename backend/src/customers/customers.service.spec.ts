import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, RelationshipStage, User } from '@prisma/client';
import { CustomersService } from './customers.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { AccountingOpsPort } from '../accounting-ops/accounting-ops.port';

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
  };
  return { tx, activities, invoiceLinks };
}

function makeService(opts?: {
  contact?: Partial<ContactOpsPort>;
  accounting?: Partial<AccountingOpsPort>;
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

  // WorkspaceContextService faked: runForUser invokes fn(tx) directly (the real
  // GUC/RLS is proven in the SQL acceptance, not re-mocked here); resolveAuthorized
  // returns the bootstrap workspace.
  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    runForUser: jest.fn(async (_user: User, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const svc = new CustomersService(workspaces, contact, accounting);
  return { svc, contact, accounting, workspaces, lastTx };
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
    // Later-phase federation slots are present but empty.
    expect(result.meetings).toMatchObject({ federated: false, source: 'meeting-ops' });
    expect(result.email).toMatchObject({ federated: false, source: 'email-ops' });
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
