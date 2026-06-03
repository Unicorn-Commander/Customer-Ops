/**
 * RLS integration proof — Phase 2 scoped tables, through the REAL Prisma client
 * connecting as the NOBYPASSRLS `customer_ops_app` role.
 *
 * This is the automated companion to the SQL acceptance scripts: it drives the
 * exact GUC chokepoint the app uses (PrismaService.withWorkspace → SET LOCAL
 * app.current_workspace) and asserts the fence holds for `customers`, the
 * Phase-2 `customer_activities` table, and the Phase-3 `customer_invoice_links`
 * (the Accounting-Ops invoice link) table:
 *   - no-GUC reads return 0 rows (fail-closed),
 *   - writes land only in the bound workspace,
 *   - a cross-workspace read sees 0 rows,
 *   - a WITH CHECK violation (writing another workspace's id) is rejected.
 *
 * GUARDED: it runs only when CUSTOMER_OPS_RLS_TEST_DATABASE_URL is set (point it
 * at the verify DB as the app role). Without it, the suite is skipped so unit
 * runs / CI without a DB stay green. Run it with:
 *
 *   CUSTOMER_OPS_RLS_TEST_DATABASE_URL=\
 *     'postgresql://localhost:5432/customer_ops' \
 *     npx jest customers.rls.int-spec
 */

import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DB_URL = process.env.CUSTOMER_OPS_RLS_TEST_DATABASE_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

// Two disjoint, valid uuidv7-shaped workspace ids for the isolation test.
const WS_A = '0190a000-7e57-7000-8000-00000000aaa1';
const WS_B = '0190a000-7e57-7000-8000-00000000bbb1';

describeIfDb('RLS integration (customer_ops_app, real Prisma)', () => {
  // Constructed in beforeAll (NOT at collection time) so a skipped run — or a
  // unit run without a DB — never instantiates a Prisma client. The app role
  // connects with NOBYPASSRLS, so the fence is live for it.
  let prisma!: PrismaService & PrismaClient;
  let owner!: PrismaClient;

  const cleanupIds: { customers: string[]; activities: string[]; invoiceLinks: string[] } = {
    customers: [],
    activities: [],
    invoiceLinks: [],
  };

  beforeAll(async () => {
    prisma = new PrismaService({
      datasources: { db: { url: DB_URL! } },
    } as any) as PrismaService & PrismaClient;

    // A separate owner client to seed/clean the non-RLS control table
    // (workspaces) and verify rows out-of-band. Falls back to the same URL.
    const ownerUrl = process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL || DB_URL!;
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

    await prisma.$connect();
    await owner.$connect();
    // Seed the two control-table workspaces as the owner (workspaces is not
    // RLS-fenced; the app role may also insert it, but the owner is cleaner).
    for (const id of [WS_A, WS_B]) {
      await owner.workspace.upsert({
        where: { id },
        update: {},
        create: { id, slug: `rls-int-${id.slice(-4)}`, displayName: `RLS Int ${id.slice(-4)}` },
      });
    }
  });

  afterAll(async () => {
    // Clean up seeded rows (children first for FK), then the workspaces.
    try {
      await owner.customerInvoiceLink.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
      await owner.customerActivity.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
      await owner.customer.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
      await owner.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
    } catch {
      /* best-effort cleanup */
    }
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('the runtime role is NOBYPASSRLS (the fence is live for it)', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ rolbypassrls: boolean }>>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it('no-GUC reads return 0 rows on all scoped tables (fail-closed)', async () => {
    // Direct query OUTSIDE withWorkspace — no GUC set on this connection.
    const c = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM customers`,
    );
    const a = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM customer_activities`,
    );
    const l = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM customer_invoice_links`,
    );
    expect(Number(c[0].n)).toBe(0);
    expect(Number(a[0].n)).toBe(0);
    expect(Number(l[0].n)).toBe(0);
  });

  it('writes land only in the bound workspace; cross-read sees 0', async () => {
    const custA = randomUUID();
    const actA = randomUUID();
    const linkA = randomUUID();
    // Write into WS_A through the GUC chokepoint.
    await prisma.withWorkspace(WS_A, 'uc-a', async (tx) => {
      await tx.customer.create({
        data: { id: custA, workspaceId: WS_A, contactId: 'contact-a', stage: 'LEAD' },
      });
      await tx.customerActivity.create({
        data: { id: actA, workspaceId: WS_A, customerId: custA, kind: 'CREATED', toStage: 'LEAD' },
      });
      await tx.customerInvoiceLink.create({
        data: {
          id: linkA,
          workspaceId: WS_A,
          customerId: custA,
          externalSource: 'customer-ops',
          externalRef: `cust:${custA}:k1`,
          entityId: 'entity-a',
          lastStatus: 'sent',
          totalAmount: '2040.0000',
        },
      });
    });
    cleanupIds.customers.push(custA);
    cleanupIds.activities.push(actA);
    cleanupIds.invoiceLinks.push(linkA);

    // Bound to WS_A: I can see my row.
    const seenInA = await prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
      tx.customer.findMany({ where: { contactId: 'contact-a' } }),
    );
    expect(seenInA).toHaveLength(1);

    // Bound to WS_B: WS_A's rows are INVISIBLE (customer, activity, invoice link).
    const seenInB = await prisma.withWorkspace(WS_B, 'uc-b', (tx) =>
      tx.customer.findMany({ where: { contactId: 'contact-a' } }),
    );
    expect(seenInB).toHaveLength(0);

    const actSeenInB = await prisma.withWorkspace(WS_B, 'uc-b', (tx) =>
      tx.customerActivity.findMany({ where: { id: actA } }),
    );
    expect(actSeenInB).toHaveLength(0);

    // The invoice link (incl. its external_ref idempotency tuple) is INVISIBLE
    // across the fence — AO references never leak between tenants.
    const linkSeenInB = await prisma.withWorkspace(WS_B, 'uc-b', (tx) =>
      tx.customerInvoiceLink.findMany({ where: { id: linkA } }),
    );
    expect(linkSeenInB).toHaveLength(0);
    const linkByRefInB = await prisma.withWorkspace(WS_B, 'uc-b', (tx) =>
      tx.customerInvoiceLink.findMany({ where: { externalRef: `cust:${custA}:k1` } }),
    );
    expect(linkByRefInB).toHaveLength(0);

    // Money round-trips with full value fidelity within the owning workspace
    // (NUMERIC(20,4); Prisma.Decimal canonicalizes, so compare by value).
    const linkInA = await prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
      tx.customerInvoiceLink.findUnique({ where: { id: linkA } }),
    );
    expect(Number(linkInA?.totalAmount)).toBe(2040);
  });

  it('WITH CHECK blocks writing a row tagged with another workspace', async () => {
    // Bound to WS_A, try to insert a customer carrying WS_B — RLS rejects it.
    await expect(
      prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
        tx.customer.create({
          data: { id: randomUUID(), workspaceId: WS_B, contactId: 'contact-evil', stage: 'LEAD' },
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    // Same for customer_activities.
    await expect(
      prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
        tx.customerActivity.create({
          data: {
            id: randomUUID(),
            workspaceId: WS_B,
            customerId: 'whatever',
            kind: 'NOTE',
            body: 'evil',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    // Same for customer_invoice_links — a link can never be written into a
    // workspace other than the GUC's (the AO idempotency tuple stays tenant-bound).
    await expect(
      prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
        tx.customerInvoiceLink.create({
          data: {
            id: randomUUID(),
            workspaceId: WS_B,
            customerId: 'whatever',
            externalSource: 'customer-ops',
            externalRef: 'cust:evil:k',
            entityId: 'entity-evil',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('cross-workspace UPDATE/DELETE are no-ops (0 rows)', async () => {
    // Seed a WS_B customer.
    const custB = randomUUID();
    await prisma.withWorkspace(WS_B, 'uc-b', (tx) =>
      tx.customer.create({
        data: { id: custB, workspaceId: WS_B, contactId: 'contact-b', stage: 'PROSPECT' },
      }),
    );
    cleanupIds.customers.push(custB);

    // Bound to WS_A, try to mutate the WS_B row -> updateMany reports 0 affected.
    const upd = await prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
      tx.customer.updateMany({ where: { id: custB }, data: { stage: 'CUSTOMER' } }),
    );
    expect(upd.count).toBe(0);

    const del = await prisma.withWorkspace(WS_A, 'uc-a', (tx) =>
      tx.customer.deleteMany({ where: { id: custB } }),
    );
    expect(del.count).toBe(0);
  });
});
