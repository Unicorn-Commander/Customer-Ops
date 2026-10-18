import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CustomerActivityKind,
  LeadIntakeStatus,
  RelationshipStage,
  User,
} from '@prisma/client';
import { LeadIntakeService } from './lead-intake.service';
import { WorkspaceContextService } from '../common/workspace/workspace-context.service';
import { ContactOpsPort } from '../contact-ops/contact-ops.port';
import { isProvisionalContactId } from './lead-label.port';

/**
 * LeadIntakeService is the `ingest_lead` keystone. These tests pin the
 * load-bearing behaviors WITHOUT a database (the RLS fence itself is proven in
 * the SQL acceptance):
 *   - a lead with no resolvable identity is rejected (400),
 *   - identity precedence: explicit contactId > Contact-Ops upsert > provisional,
 *   - degrade-clean: CO dormant + provisional disabled ⇒ stays PENDING (nothing lost),
 *   - the provisional fallback mints a deterministic 'prov:' id + projects a LEAD,
 *   - a Contact-Ops upsert resolves to the canonical person_id,
 *   - NO-DOWNGRADE: re-ingesting a known CUSTOMER never drops it back to LEAD,
 *   - every resolution logs exactly one INGESTED activity.
 *
 * The WorkspaceContext GUC chokepoint is faked by running fn(tx) directly; the
 * Contact-Ops port + ConfigService are mocks.
 */
const WS = '0190a000-7e57-7000-8000-00000000c007';
const UC_UID = 'kc-aaron-sub';
const aaron = { id: 'local-aaron', email: 'aaron@magicunicorn.tech', keycloakId: UC_UID } as User;

/** A stateful fake tx covering the lead_intakes + customers + activity surface. */
function makeTx(opts?: { existingCustomer?: any }) {
  const store: { intake: any | null } = { intake: null };
  const activities: any[] = [];
  const customers: any[] = opts?.existingCustomer ? [opts.existingCustomer] : [];

  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ ws: WS }]),
    leadIntake: {
      upsert: jest.fn(async ({ create, update }: any) => {
        if (!store.intake) {
          store.intake = {
            id: 'li-1',
            workspaceId: WS,
            status: LeadIntakeStatus.PENDING,
            provisional: false,
            resolvedContactId: null,
            customerId: null,
            statusDetail: null,
            resolvedAt: null,
            score: null,
            expectedValue: null,
            currency: 'USD',
            ownerUserKey: null,
            notes: null,
            displayName: null,
            email: null,
            phone: null,
            orgName: null,
            createdAt: new Date('2026-06-04T00:00:00Z'),
            updatedAt: new Date('2026-06-04T00:00:00Z'),
            ...create,
            tags: create.tags ?? [],
            priority: create.priority ?? 'MEDIUM',
          };
        } else {
          store.intake = { ...store.intake, ...update };
        }
        return store.intake;
      }),
      update: jest.fn(async ({ data }: any) => {
        store.intake = { ...store.intake, ...data };
        return store.intake;
      }),
      findUnique: jest.fn(async () => store.intake),
      findMany: jest.fn(async () => (store.intake ? [store.intake] : [])),
      groupBy: jest.fn(async () => []),
    },
    customer: {
      findFirst: jest.fn(async ({ where }: any) =>
        customers.find((c) => c.contactId === where.contactId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `cust-${customers.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          isLost: false,
          ...data,
        };
        customers.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = customers.findIndex((c) => c.id === where.id);
        const merged = { ...(customers[idx] ?? { id: where.id }), ...data };
        if (idx >= 0) customers[idx] = merged;
        return merged;
      }),
      delete: jest.fn(async () => ({})),
    },
    customerActivity: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `act-${activities.length + 1}`, createdAt: new Date(), ...data };
        activities.push(row);
        return row;
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  return { tx, store, activities, customers };
}

function makeService(opts?: {
  contact?: Partial<ContactOpsPort>;
  config?: Record<string, string | undefined>;
  tx?: any;
}) {
  const contact: ContactOpsPort = {
    getContact: jest.fn().mockResolvedValue(null),
    getContactSummaries: jest.fn().mockResolvedValue(new Map()),
    listContacts: jest.fn().mockResolvedValue({ items: [], count: 0, nextCursor: null }),
    getWorkspaceProjection: jest.fn().mockResolvedValue(null),
    upsertContact: jest.fn().mockResolvedValue(null),
    ...(opts?.contact ?? {}),
  } as any;

  const cfg = opts?.config ?? {};
  const config = {
    get: jest.fn((k: string) => cfg[k]),
  } as unknown as ConfigService;

  const workspaces = {
    resolveAuthorized: jest.fn().mockResolvedValue(WS),
    runForUser: jest.fn(async (_user: User, fn: any) => fn(opts?.tx)),
  } as unknown as WorkspaceContextService;

  const svc = new LeadIntakeService(workspaces, contact, config);
  return { svc, contact, config, workspaces };
}

describe('LeadIntakeService — ingest_lead keystone', () => {
  it('rejects a lead with no contactId and no identity key (400)', async () => {
    const { tx } = makeTx();
    const { svc } = makeService({ tx });
    await expect(
      svc.ingestForUser(aaron, { source: 'northwind', sourceDedupKey: 'L-1' }, WS),
    ).rejects.toThrow(BadRequestException);
    expect(tx.leadIntake.upsert).not.toHaveBeenCalled();
  });

  it('resolves inline via an EXPLICIT contactId and projects a LEAD (no CO call)', async () => {
    const { tx, store, customers, activities } = makeTx();
    const { svc, contact } = makeService({ tx });

    const res = await svc.ingestForUser(
      aaron,
      { source: 'manual', sourceDedupKey: 'M-1', contactId: 'co-person-7', displayName: 'Jane' },
      WS,
    );

    expect(res.resolved).toBe(true);
    expect(res.via).toBe('explicit');
    expect(res.provisional).toBe(false);
    expect(res.contactId).toBe('co-person-7');
    expect(contact.upsertContact).not.toHaveBeenCalled(); // explicit id skips CO
    expect(store.intake.status).toBe(LeadIntakeStatus.RESOLVED);
    // One Customer LEAD projection on the explicit id.
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ contactId: 'co-person-7', stage: RelationshipStage.LEAD });
    // Exactly one INGESTED activity.
    const ingested = activities.filter((a) => a.kind === CustomerActivityKind.INGESTED);
    expect(ingested).toHaveLength(1);
  });

  it('degrade-clean: CO dormant + provisional disabled ⇒ stays PENDING, nothing lost', async () => {
    const { tx, store, customers } = makeTx();
    const { svc } = makeService({
      tx,
      config: { LEAD_INTAKE_PROVISIONAL_IDENTITY: 'false' },
      contact: { upsertContact: jest.fn().mockResolvedValue(null) },
    });

    const res = await svc.ingestForUser(
      aaron,
      { source: 'northwind', sourceDedupKey: 'L-2', email: 'lead@acme.test' },
      WS,
    );

    expect(res.resolved).toBe(false);
    expect(store.intake.status).toBe(LeadIntakeStatus.PENDING);
    expect(customers).toHaveLength(0); // no projection until identity resolves
  });

  it('provisional fallback: CO dormant + provisional ON ⇒ deterministic prov: id + LEAD', async () => {
    const { tx, store, customers } = makeTx();
    const { svc } = makeService({
      tx,
      config: {}, // provisional defaults ON
      contact: { upsertContact: jest.fn().mockResolvedValue(null) },
    });

    const res = await svc.ingestForUser(
      aaron,
      { source: 'northwind', sourceDedupKey: 'L-3', email: 'Lead@Acme.test', displayName: 'A Lead' },
      WS,
    );

    expect(res.resolved).toBe(true);
    expect(res.via).toBe('provisional');
    expect(res.provisional).toBe(true);
    expect(isProvisionalContactId(res.contactId!)).toBe(true);
    expect(store.intake.status).toBe(LeadIntakeStatus.RESOLVED);
    expect(customers).toHaveLength(1);
    expect(customers[0].contactId).toBe(res.contactId);
  });

  it('resolves via a Contact-Ops upsert to the canonical person_id', async () => {
    const { tx, customers } = makeTx();
    const upsert = jest.fn().mockResolvedValue({ contactId: 'co-canon-99', created: true, etag: 'e1' });
    const { svc } = makeService({ tx, contact: { upsertContact: upsert } });

    const res = await svc.ingestForUser(
      aaron,
      { source: 'loopnet', sourceDedupKey: 'LN-1', email: 'broker@x.test' },
      WS,
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(res.via).toBe('contact-ops');
    expect(res.provisional).toBe(false);
    expect(res.contactId).toBe('co-canon-99');
    expect(customers[0].contactId).toBe('co-canon-99');
  });

  it('NO-DOWNGRADE: re-ingesting a known CUSTOMER never drops it back to LEAD', async () => {
    const existing = {
      id: 'cust-existing',
      workspaceId: WS,
      contactId: 'co-person-7',
      stage: RelationshipStage.CUSTOMER,
      ownerUserKey: null,
      expectedValue: null,
      isLost: false,
    };
    const { tx, activities, customers } = makeTx({ existingCustomer: existing });
    const { svc } = makeService({ tx });

    const res = await svc.ingestForUser(
      aaron,
      { source: 'manual', sourceDedupKey: 'M-2', contactId: 'co-person-7' },
      WS,
    );

    expect(res.resolved).toBe(true);
    // No new Customer; the existing one keeps CUSTOMER stage.
    expect(customers).toHaveLength(1);
    expect(customers[0].stage).toBe(RelationshipStage.CUSTOMER);
    // The create path was never taken.
    expect(tx.customer.create).not.toHaveBeenCalled();
    // Still logs an INGESTED activity (the graduation provenance).
    expect(activities.filter((a) => a.kind === CustomerActivityKind.INGESTED)).toHaveLength(1);
  });

  it('re-pushes a RESOLVED intake through Contact-Ops without a second relationship or stage change', async () => {
    const { tx, store, customers } = makeTx();
    const upsert = jest.fn().mockResolvedValue({
      contactId: 'co-repush-1',
      created: false,
      etag: 'e2',
    });
    const { svc } = makeService({ tx, contact: { upsertContact: upsert } });

    await svc.ingestForUser(
      aaron,
      {
        source: 'northwind',
        sourceDedupKey: 'same-lead',
        displayName: 'Before Name',
        email: 'before@acme.test',
        orgName: 'Before Co',
        tags: ['old-tag'],
      },
      WS,
    );
    customers[0].stage = RelationshipStage.CUSTOMER;

    const result = await svc.ingestForUser(
      aaron,
      {
        source: 'northwind',
        sourceDedupKey: 'same-lead',
        displayName: 'Refreshed Name',
        email: 'after@acme.test',
        phone: '+15551234567',
        orgName: 'After Co',
        tags: ['new-tag'],
      },
      WS,
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][1]).toMatchObject({
      displayName: 'Refreshed Name',
      email: 'after@acme.test',
      phone: '+15551234567',
      orgName: 'After Co',
      tags: ['new-tag'],
      source: 'northwind',
      sourceDedupKey: 'same-lead',
    });
    expect(store.intake).toMatchObject({
      displayName: 'Refreshed Name',
      email: 'after@acme.test',
      phone: '+15551234567',
      orgName: 'After Co',
      tags: ['new-tag'],
      status: LeadIntakeStatus.RESOLVED,
    });
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      id: 'cust-1',
      contactId: 'co-repush-1',
      stage: RelationshipStage.CUSTOMER,
    });
    expect(result.customerId).toBe('cust-1');
  });

  it('mintProvisional is deterministic on email (same person ⇒ same prov id)', async () => {
    const run = async (dedup: string) => {
      const { tx } = makeTx();
      const { svc } = makeService({ tx, contact: { upsertContact: jest.fn().mockResolvedValue(null) } });
      const res = await svc.ingestForUser(
        aaron,
        { source: 'northwind', sourceDedupKey: dedup, email: 'same@acme.test' },
        WS,
      );
      return res.contactId!;
    };
    const a = await run('K-1');
    const b = await run('K-2'); // different dedup key, SAME email
    expect(a).toBe(b); // identity-keyed, so the same person maps to the same projection
  });
});

// ============================================================================
// resolvePending PASS B — the provisional → canonical RECONCILIATION (the
// "wire P-00059 later" payoff). When Contact-Ops becomes reachable, the
// reconciler re-runs the upsert for RESOLVED+provisional intakes and swaps the
// deterministic 'prov:' id for the canonical Contact-Ops person_id on BOTH the
// intake and its Customer projection — MERGING into any pre-existing canonical
// relationship (the destructive activity-move + provisional-delete path). These
// pin that destructive branch happens on exactly the right ids.
// ============================================================================
describe('LeadIntakeService — resolvePending pass B (provisional → canonical reconciliation)', () => {
  /**
   * A fake tx tailored to pass B. `leadIntake.findMany` dispatches on the query:
   *   - the PENDING/FAILED scan (pass A) → [] (nothing open to resolve),
   *   - the RESOLVED+provisional scan (pass B) → the seeded provisional intake.
   * `customer.findFirst({contactId})` returns whatever canonical row is seeded for
   * that id (or null). updateMany/delete/update are spies we assert against.
   */
  function makePassBTx(opts: { intake: any; canonicalCustomer?: any }) {
    const customers: any[] = [];
    if (opts.canonicalCustomer) customers.push(opts.canonicalCustomer);
    const calls = {
      activityUpdateMany: [] as any[],
      customerDelete: [] as any[],
      customerUpdate: [] as any[],
      intakeUpdate: [] as any[],
    };

    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ ws: WS }]),
      leadIntake: {
        findMany: jest.fn(async ({ where }: any) => {
          // Pass B asks for RESOLVED + provisional:true.
          if (where?.status === LeadIntakeStatus.RESOLVED && where?.provisional === true) {
            return [opts.intake];
          }
          // Pass A asks for status IN [...]; nothing open in these tests.
          return [];
        }),
        update: jest.fn(async ({ where, data }: any) => {
          calls.intakeUpdate.push({ where, data });
          return { ...opts.intake, ...data };
        }),
      },
      customer: {
        findFirst: jest.fn(async ({ where }: any) =>
          customers.find((c) => c.contactId === where.contactId) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          calls.customerUpdate.push({ where, data });
          return { id: where.id, ...data };
        }),
        delete: jest.fn(async ({ where }: any) => {
          calls.customerDelete.push({ where });
          return {};
        }),
      },
      customerActivity: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          calls.activityUpdateMany.push({ where, data });
          return { count: 1 };
        }),
      },
    };
    return { tx, calls };
  }

  const provIntake = (over: Record<string, any> = {}) => ({
    id: 'li-prov',
    workspaceId: WS,
    status: LeadIntakeStatus.RESOLVED,
    provisional: true,
    resolvedContactId: 'prov:abc123',
    customerId: 'cust-prov',
    source: 'northwind',
    sourceDedupKey: 'L-9',
    displayName: 'Jane Lead',
    email: 'jane@acme.test',
    phone: null,
    orgName: 'Acme',
    tags: [],
    ...over,
  });

  it('(a) Contact-Ops UNREACHABLE → pass B never runs, NO upgrade attempted', async () => {
    const { tx, calls } = makePassBTx({ intake: provIntake() });
    const upsert = jest.fn().mockResolvedValue({ contactId: 'co-canon-1' });
    // No CONTACT_OPS_BASE_URL ⇒ coReachable() false ⇒ pass B is skipped wholesale.
    const { svc } = makeService({ tx, config: {}, contact: { upsertContact: upsert } });

    const res = await svc.resolvePendingForUser(aaron, {}, WS);

    expect(res.coReachable).toBe(false);
    expect(res.provisionalUpgraded).toBe(0);
    // The provisional intake was never even scanned (pass B is gated before the read).
    expect(upsert).not.toHaveBeenCalled();
    expect(tx.leadIntake.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ provisional: true }) }),
    );
    expect(calls.activityUpdateMany).toHaveLength(0);
    expect(calls.customerDelete).toHaveLength(0);
  });

  it('(b) newId !== oldId and NO existing canonical relationship → rename intake + Customer to the canonical id', async () => {
    // No canonical customer seeded on the new id → the "just rename" branch.
    const { tx, calls } = makePassBTx({ intake: provIntake() });
    const upsert = jest.fn().mockResolvedValue({ contactId: 'co-canon-1' });
    const { svc } = makeService({
      tx,
      config: { CONTACT_OPS_BASE_URL: 'https://contacts.example.test' }, // coReachable
      contact: { upsertContact: upsert },
    });

    const res = await svc.resolvePendingForUser(aaron, {}, WS);

    expect(res.coReachable).toBe(true);
    expect(res.provisionalUpgraded).toBe(1);
    // No merge: the provisional customer is RE-POINTED to the canonical id in place.
    expect(calls.customerUpdate).toEqual([
      { where: { id: 'cust-prov' }, data: { contactId: 'co-canon-1' } },
    ]);
    // Nothing destructive happened.
    expect(calls.activityUpdateMany).toHaveLength(0);
    expect(calls.customerDelete).toHaveLength(0);
    // The intake re-points + clears the provisional flag.
    expect(calls.intakeUpdate[0].data).toMatchObject({
      resolvedContactId: 'co-canon-1',
      provisional: false,
    });
  });

  it('(c) MERGE: a DISTINCT canonical relationship already exists → move activities, delete the provisional, re-point the intake', async () => {
    // A canonical customer already lives on the new id (id 'cust-canon'), distinct
    // from the provisional projection ('cust-prov') → the destructive merge branch.
    const canonical = { id: 'cust-canon', workspaceId: WS, contactId: 'co-canon-1', stage: RelationshipStage.PROSPECT };
    const { tx, calls } = makePassBTx({ intake: provIntake(), canonicalCustomer: canonical });
    const upsert = jest.fn().mockResolvedValue({ contactId: 'co-canon-1' });
    const { svc } = makeService({
      tx,
      config: { CONTACT_OPS_BASE_URL: 'https://contacts.example.test' },
      contact: { upsertContact: upsert },
    });

    const res = await svc.resolvePendingForUser(aaron, {}, WS);

    expect(res.provisionalUpgraded).toBe(1);
    // 1) The activity trail is moved FROM the provisional customer TO the canonical one.
    expect(calls.activityUpdateMany).toEqual([
      { where: { customerId: 'cust-prov' }, data: { customerId: 'cust-canon' } },
    ]);
    // 2) The now-empty provisional customer is deleted (its unique (ws, contactId)
    //    would otherwise block the swap).
    expect(calls.customerDelete).toEqual([{ where: { id: 'cust-prov' } }]);
    // 3) The provisional customer is NOT renamed (we deleted it, not re-pointed it).
    expect(calls.customerUpdate).toHaveLength(0);
    // 4) The intake re-points at the canonical projection + drops the provisional flag.
    expect(calls.intakeUpdate[0]).toMatchObject({
      where: { id: 'li-prov' },
      data: { resolvedContactId: 'co-canon-1', provisional: false, customerId: 'cust-canon' },
    });
    expect(calls.intakeUpdate[0].data.statusDetail).toMatch(/merged into canonical/i);
  });

  it('(d) newId === oldId → no-op (no activity move, no delete, no intake update)', async () => {
    // Contact-Ops resolves the SAME id the provisional already carried → nothing to swap.
    const { tx, calls } = makePassBTx({ intake: provIntake({ resolvedContactId: 'prov:abc123' }) });
    const upsert = jest.fn().mockResolvedValue({ contactId: 'prov:abc123' });
    const { svc } = makeService({
      tx,
      config: { CONTACT_OPS_BASE_URL: 'https://contacts.example.test' },
      contact: { upsertContact: upsert },
    });

    const res = await svc.resolvePendingForUser(aaron, {}, WS);

    // Scanned but not upgraded (the early return on newId === oldId).
    expect(res.provisionalUpgraded).toBe(0);
    expect(calls.activityUpdateMany).toHaveLength(0);
    expect(calls.customerDelete).toHaveLength(0);
    expect(calls.customerUpdate).toHaveLength(0);
    expect(calls.intakeUpdate).toHaveLength(0);
  });

  it('the MERGE branch is skipped when the canonical IS the provisional customer (same id) — falls back to rename', async () => {
    // Edge: a canonical row exists on the new id but it IS intake.customerId (the
    // findFirst returned our own projection). The merge guard (canonical.id !==
    // intake.customerId) is false → the rename branch runs, no destructive move.
    const sameAsProvisional = { id: 'cust-prov', workspaceId: WS, contactId: 'co-canon-1', stage: RelationshipStage.LEAD };
    const { tx, calls } = makePassBTx({ intake: provIntake(), canonicalCustomer: sameAsProvisional });
    const upsert = jest.fn().mockResolvedValue({ contactId: 'co-canon-1' });
    const { svc } = makeService({
      tx,
      config: { CONTACT_OPS_BASE_URL: 'https://contacts.example.test' },
      contact: { upsertContact: upsert },
    });

    const res = await svc.resolvePendingForUser(aaron, {}, WS);
    expect(res.provisionalUpgraded).toBe(1);
    expect(calls.activityUpdateMany).toHaveLength(0);
    expect(calls.customerDelete).toHaveLength(0);
    // Renamed in place instead.
    expect(calls.customerUpdate).toEqual([
      { where: { id: 'cust-prov' }, data: { contactId: 'co-canon-1' } },
    ]);
  });
});


describe('structured names through intake staging', () => {
  it('preserves explicit names for Contact-Ops resolution', async () => {
    const { tx, store } = makeTx();
    const { svc, contact } = makeService({ tx });
    await svc.ingestForUser(aaron, {
      source: 'synthetic', sourceDedupKey: 'names', displayName: 'Synthetic Contact',
      givenName: 'Synthetic', familyName: 'Contact', nicknames: ['Example'],
    }, WS);
    expect(store.intake.rawPayload).toMatchObject({
      given_name: 'Synthetic', family_name: 'Contact', nicknames: ['Example'],
    });
    expect(contact.upsertContact).toHaveBeenCalledWith({ ucUid: UC_UID, workspaceId: WS }, expect.objectContaining({
      givenName: 'Synthetic', familyName: 'Contact', nicknames: ['Example'],
    }));
  });
});
