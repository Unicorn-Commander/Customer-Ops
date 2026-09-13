import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { prepareQuoteSnapshot, quoteSnapshotSelect } from './quote-snapshot';
import { newShareToken, sha256 } from './quote-secrets';

const appUrl = process.env.CUSTOMER_OPS_RLS_TEST_DATABASE_URL;
const describeDb = appUrl ? describe : describe.skip;
const tables = [
  'quote_versions',
  'quote_share_tokens',
  'quote_pending_acceptances',
  'quote_events',
];
describeDb('M2 persistence on real PostgreSQL RLS', () => {
  let db: PrismaService, owner: PrismaClient;
  const a = randomUUID(),
    b = randomUUID();
  const qa = randomUUID(),
    qb = randomUUID();
  const validUntil = new Date(Date.now() + 86400000);
  let va: any, vb: any, tokenA: any;
  const capability = newShareToken();
  const presentation = {
    customer: { display_name: 'Synthetic recipient', org_name: null, attention: null },
    letterhead: { legal_name: 'Synthetic vendor', address_lines: [] },
  };
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: appUrl } } });
    owner = new PrismaClient({
      datasources: { db: { url: process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL || appUrl } },
    });
    for (const [workspaceId, quoteId] of [
      [a, qa],
      [b, qb],
    ]) {
      await owner.workspace.create({
        data: { id: workspaceId, slug: 'm2-' + workspaceId, displayName: 'Synthetic M2 workspace' },
      });
      const customer = await owner.customer.create({
        data: { workspaceId, contactId: randomUUID() },
      });
      await owner.quote.create({
        data: {
          id: quoteId,
          workspaceId,
          customerId: customer.id,
          number: 'Q-2026-0001',
          title: 'Synthetic proposal',
          vendorOfRecord: 'Synthetic vendor',
          validUntil,
          createdBy: 'fixture',
          internalNotesMd: 'PRIVATE-NOTE-SENTINEL',
          splitRule: { kind: 'none', notes: 'PRIVATE-SPLIT-SENTINEL' },
        },
      });
      const section = await owner.quoteSection.create({
        data: {
          workspaceId,
          quoteId,
          kind: 'scope',
          heading: 'Scope',
          internalBasisMd: 'PRIVATE-BASIS-SENTINEL',
        },
      });
      await owner.quoteLine.create({
        data: {
          workspaceId,
          quoteId,
          sectionId: section.id,
          kind: 'one_time',
          label: 'Synthetic deliverable',
          unitPriceCents: 333,
        },
      });
      await owner.quoteCost.create({
        data: {
          workspaceId,
          quoteId,
          label: 'PRIVATE-COST-SENTINEL',
          amountCents: 1,
          kind: 'other',
        },
      });
    }
    for (const [workspaceId, quoteId] of [
      [a, qa],
      [b, qb],
    ]) {
      const version = await db.withWorkspace(workspaceId, 'fixture', async (tx) => {
        const prepared = await prepareQuoteSnapshot(tx, workspaceId, quoteId, presentation);
        return tx.quoteVersion.create({
          data: {
            workspaceId,
            quoteId,
            versionNo: 1,
            snapshot: prepared.snapshot as any,
            renderHash: prepared.renderHash,
          },
        });
      });
      if (workspaceId === a) va = version;
      else vb = version;
    }
    tokenA = await db.withWorkspace(a, 'fixture', (tx) =>
      tx.quoteShareToken.create({
        data: {
          workspaceId: a,
          quoteId: qa,
          versionId: va.id,
          tokenHash: capability.tokenHash,
          expiresAt: validUntil,
        },
      }),
    );
    await db.withWorkspace(a, 'fixture', async (tx) => {
      const now = new Date();
      await tx.quotePendingAcceptance.create({
        data: {
          workspaceId: a,
          quoteId: qa,
          versionId: va.id,
          tokenId: tokenA.id,
          name: 'Synthetic',
          email: 'fixture@example.invalid',
          selectedLineIds: [],
          codeHash: sha256('fixture-code-hmac-placeholder'),
          beginKeyHash: sha256('begin'),
          requestHash: sha256('request'),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 600000),
        },
      });
      await tx.quoteEvent.create({
        data: { workspaceId: a, quoteId: qa, versionId: va.id, kind: 'sent', actor: 'fixture' },
      });
    });
  });
  afterAll(async () => {
    if (owner) {
      for (const table of [
        'quote_events',
        'quote_pending_acceptances',
        'quote_share_tokens',
        'quote_versions',
        'quote_costs',
        'quote_lines',
        'quote_sections',
        'quotes',
      ])
        await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE workspace_id IN ($1,$2)`, a, b);
      await owner.customer.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await owner.workspace.deleteMany({ where: { id: { in: [a, b] } } });
      await owner.$disconnect();
    }
    if (db) await db.$disconnect();
  });
  it('forces RLS and four policies on each new tenant table', async () => {
    for (const table of tables) {
      const rows: any[] =
        await owner.$queryRaw`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=${'public.' + table}::regclass`;
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies: any[] =
        await owner.$queryRaw`SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename=${table}`;
      expect(policies.map((p) => p.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(await db.$queryRawUnsafe(`SELECT id FROM "${table}"`)).toEqual([]);
      expect(
        await db.withWorkspace(b, 'fixture', (tx) =>
          tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE workspace_id=$1`, a),
        ),
      ).toEqual([]);
    }
  });
  it('snapshot queries exclude studio fields and freeze canonical exact money', async () => {
    expect(Object.keys(quoteSnapshotSelect)).not.toEqual(
      expect.arrayContaining(['internalNotesMd', 'splitRule']),
    );
    const snapshot = va.snapshot;
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-');
    expect(snapshot.totals.lines[0].payment_parts).toEqual([167, 166]);
    expect(snapshot.totals.deposit_cents + snapshot.totals.remainder_total_cents).toBe(
      snapshot.totals.one_time_cents,
    );
    for (const key of ['costs', 'recipients', 'internal_notes_md', 'split_rule'])
      expect(snapshot).not.toHaveProperty(key);
    expect(snapshot.sections[0]).not.toHaveProperty('internal_basis_md');
  });
  it('reveals only the capability workspace then requires the normal RLS fence', async () => {
    const found: any[] =
      await db.$queryRaw`SELECT public.quote_token_workspace(${capability.tokenHash}) AS workspace`;
    expect(found).toEqual([{ workspace: a }]);
    const missing: any[] =
      await db.$queryRaw`SELECT public.quote_token_workspace(${sha256('missing')}) AS workspace`;
    expect(missing).toEqual([{ workspace: null }]);
    expect(
      await db.quoteShareToken.findUnique({ where: { tokenHash: capability.tokenHash } }),
    ).toBeNull();
    expect(
      await db.withWorkspace(b, 'fixture', (tx) =>
        tx.quoteShareToken.findUnique({ where: { tokenHash: capability.tokenHash } }),
      ),
    ).toBeNull();
  });
  it('refuses cross-workspace writes and cross-parent token references', async () => {
    for (const table of ['quote_versions', 'quote_share_tokens', 'quote_pending_acceptances']) {
      expect(
        await db.withWorkspace(b, 'fixture', (tx) =>
          tx.$executeRawUnsafe(`UPDATE "${table}" SET workspace_id=$1 WHERE workspace_id=$2`, b, a),
        ),
      ).toBe(0);
      expect(
        await db.withWorkspace(b, 'fixture', (tx) =>
          tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE workspace_id=$1`, a),
        ),
      ).toBe(0);
    }
    await expect(
      db.withWorkspace(b, 'fixture', (tx) =>
        tx.quoteVersion.create({
          data: {
            workspaceId: a,
            quoteId: qa,
            versionNo: 2,
            disposition: 'superseded',
            snapshot: va.snapshot,
            renderHash: va.renderHash,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quoteShareToken.create({
          data: {
            workspaceId: a,
            quoteId: qa,
            versionId: vb.id,
            tokenHash: newShareToken().tokenHash,
            expiresAt: validUntil,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(b, 'fixture', (tx) =>
        tx.quoteEvent.create({
          data: { workspaceId: a, quoteId: qa, kind: 'forged', actor: 'fixture' },
        }),
      ),
    ).rejects.toThrow();
  });
  it('rejects cross-workspace token/pending inserts and enforces the pending TTL and attempt ceiling', async () => {
    await expect(
      db.withWorkspace(b, 'fixture', (tx) =>
        tx.quoteShareToken.create({
          data: {
            workspaceId: a,
            quoteId: qa,
            versionId: va.id,
            tokenHash: newShareToken().tokenHash,
            expiresAt: validUntil,
          },
        }),
      ),
    ).rejects.toThrow();
    const now = new Date();
    const pending = {
      workspaceId: a,
      quoteId: qa,
      versionId: va.id,
      tokenId: tokenA.id,
      name: 'Synthetic',
      email: 'fixture@example.invalid',
      selectedLineIds: [],
      codeHash: sha256('fixture-verifier'),
      beginKeyHash: sha256(randomUUID()),
      requestHash: sha256('fixture'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    };
    await expect(
      db.withWorkspace(b, 'fixture', (tx) => tx.quotePendingAcceptance.create({ data: pending })),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quotePendingAcceptance.create({ data: { ...pending, attempts: 6 } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quotePendingAcceptance.create({
          data: { ...pending, expiresAt: new Date(now.getTime() + 600001) },
        }),
      ),
    ).rejects.toThrow();
  });
  it('keeps published snapshots immutable and events append-only', async () => {
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quoteVersion.update({ where: { id: va.id }, data: { snapshot: {} } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quoteEvent.updateMany({ where: { quoteId: qa }, data: { kind: 'edited' } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, 'fixture', (tx) => tx.quoteEvent.deleteMany({ where: { quoteId: qa } })),
    ).rejects.toThrow();
  });
  it('pins token expiry and cannot undo revocation or token identity', async () => {
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quoteShareToken.create({
          data: {
            workspaceId: a,
            quoteId: qa,
            versionId: va.id,
            tokenHash: newShareToken().tokenHash,
            expiresAt: new Date(validUntil.getTime() + 1000),
          },
        }),
      ),
    ).rejects.toThrow();
    await db.withWorkspace(a, 'fixture', (tx) =>
      tx.quoteShareToken.update({ where: { id: tokenA.id }, data: { revokedAt: new Date() } }),
    );
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quoteShareToken.update({ where: { id: tokenA.id }, data: { revokedAt: null } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, 'fixture', (tx) =>
        tx.quoteShareToken.update({
          where: { id: tokenA.id },
          data: { tokenHash: newShareToken().tokenHash },
        }),
      ),
    ).rejects.toThrow();
  });
});
