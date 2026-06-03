import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerActivityKind, RelationshipStage, User } from '@prisma/client';
import { CustomersService } from './customers.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';

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
  };
  return { tx, activities };
}

function makeService(opts?: { contact?: Partial<ContactOpsPort> }) {
  const contact: ContactOpsPort = {
    getContact: jest.fn().mockResolvedValue(null),
    getContactSummaries: jest.fn().mockResolvedValue(new Map()),
    listContacts: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    getWorkspaceProjection: jest.fn().mockResolvedValue(null),
    ...(opts?.contact ?? {}),
  } as any;

  // WorkspaceContextService faked: runForUser invokes fn(tx) directly (the real
  // GUC/RLS is proven in the SQL acceptance, not re-mocked here); resolveAuthorized
  // returns the bootstrap workspace.
  const lastTx = { current: null as any };
  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    runForUser: jest.fn(async (_user: User, fn: any) => fn(lastTx.current)),
  } as unknown as WorkspaceContextService;

  const svc = new CustomersService(workspaces, contact);
  return { svc, contact, workspaces, lastTx };
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
    // Phase-3 federation slots are present but empty.
    expect(result.invoices).toMatchObject({ federated: false, source: 'accounting-ops', items: [] });
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
