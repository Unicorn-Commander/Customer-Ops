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
