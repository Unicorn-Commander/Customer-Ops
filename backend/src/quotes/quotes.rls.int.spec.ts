import { Test } from '@nestjs/testing';
import { QuotesController } from './quotes.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleGuard } from '../common/workspace/workspace-role.guard';
import { randomUUID } from 'crypto';
import { PrismaClient, User, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotesService } from './quotes.service';
const appUrl = process.env.CUSTOMER_OPS_RLS_TEST_DATABASE_URL;
const describeDb = appUrl ? describe : describe.skip;
const tables = [
  'quotes',
  'quote_sections',
  'quote_lines',
  'quote_costs',
  'quote_recipients',
  'quote_attachments',
  'quote_counters',
  'price_book_items',
];
describeDb('quotes real RLS and CRUD', () => {
  let db: PrismaService, owner: PrismaClient, service: QuotesService;
  const a = randomUUID(),
    b = randomUUID(),
    customerA = randomUUID(),
    customerB = randomUUID();
  const user = { id: randomUUID(), keycloakId: 'synthetic-quotes-actor' } as User;
  let q: any, other: any;
  const call = (action: string, args: any = {}, ws = a) => service.execute(user, ws, action, args);
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: appUrl } } });
    owner = new PrismaClient({
      datasources: { db: { url: process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL || appUrl } },
    });
    for (const [id, customerId] of [
      [a, customerA],
      [b, customerB],
    ]) {
      await owner.workspace.create({
        data: { id, slug: 'quotes-' + id, displayName: 'Synthetic quotes workspace' },
      });
      await owner.customer.create({
        data: { id: customerId, workspaceId: id, contactId: randomUUID() },
      });
    }
    service = new QuotesService(
      db,
      { get: () => '1' } as any,
      { resolveAuthorized: async (_: unknown, ws: string) => ws } as any,
      { roleInWorkspace: async () => WorkspaceRole.MEMBER } as any,
    );
    q = await call('create_quote', {
      data: { customerId: customerA, title: 'Synthetic quote', vendorOfRecord: 'Synthetic vendor' },
    });
    other = await call(
      'create_quote',
      { data: { customerId: customerB, title: 'Other quote', vendorOfRecord: 'Synthetic vendor' } },
      b,
    );
  });
  afterAll(async () => {
    if (owner) {
      for (const t of [
        'quote_events',
        'quote_lines',
        'quote_sections',
        'quote_costs',
        'quote_recipients',
        'quote_attachments',
        'quotes',
        'price_book_items',
        'quote_counters',
      ])
        await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE workspace_id IN ($1,$2)`, a, b);
      await owner.auditLog.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await owner.customer.deleteMany({ where: { workspaceId: { in: [a, b] } } });
      await owner.workspace.deleteMany({ where: { id: { in: [a, b] } } });
      await owner.$disconnect();
    }
    if (db) await db.$disconnect();
  });
  it('runs without BYPASSRLS and FORCE/per-command policies cover every table', async () => {
    const roles = await db.$queryRaw<
      any[]
    >`SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user`;
    expect(roles[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    for (const name of tables) {
      const rows = await owner.$queryRaw<
        any[]
      >`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=${name}`;
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await owner.$queryRaw<
        any[]
      >`SELECT cmd FROM pg_policies WHERE tablename=${name}`;
      expect(policies.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });
  it('reads fail closed without GUC and cannot cross workspaces', async () => {
    for (const t of tables) expect(await db.$queryRawUnsafe(`SELECT * FROM "${t}"`)).toEqual([]);
    expect((await call('list_quotes')).map((x: any) => x.id)).toEqual([q.id]);
    await expect(call('get_quote', { quote_id: other.id })).rejects.toThrow('not found');
  });
  it('with-check and composite parent keys reject cross-workspace children', async () => {
    await expect(
      db.withWorkspace(a, user.keycloakId, (tx) =>
        tx.quoteSection.create({
          data: { workspaceId: b, quoteId: other.id, kind: 'scope', heading: 'Cross' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a, user.keycloakId, (tx) =>
        tx.quoteSection.create({
          data: { workspaceId: a, quoteId: other.id, kind: 'scope', heading: 'Cross parent' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      call('create_quote', {
        data: { customerId: customerB, title: 'Cross customer', vendorOfRecord: 'Synthetic' },
      }),
    ).rejects.toThrow('not found');
  });
  it('serializes concurrent allocation; committed numbers are not reused', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call('create_quote', {
          data: { customerId: customerA, title: 'Concurrent ' + i, vendorOfRecord: 'Synthetic' },
        }),
      ),
    );
    expect(new Set(results.map((x) => x.number)).size).toBe(5);
    await expect(
      db.withWorkspace(a, user.keycloakId, (tx) =>
        tx.quoteCounter.updateMany({ where: { workspaceId: a }, data: { lastNumber: 1 } }),
      ),
    ).rejects.toThrow('reused');
    expect(
      (
        await db
          .withWorkspace(a, user.keycloakId, (tx) =>
            tx.quoteCounter.deleteMany({ where: { workspaceId: a } }),
          )
          .catch((e) => {
            if (String(e).includes('permission denied')) return { count: 0 };
            throw e;
          })
      ).count,
    ).toBe(0);
  });
  it('CRUD computes totals, cannot move a line across quotes, and rolls invalid edits back', async () => {
    let x = await call('add_quote_section', {
      quote_id: q.id,
      data: { kind: 'scope', heading: 'Work', internalBasisMd: 'Internal synthetic basis' },
    });
    x = await call('add_quote_line', {
      quote_id: q.id,
      data: {
        sectionId: x.sections[0].id,
        kind: 'one_time',
        label: 'Fixture line',
        qty: '1.5',
        unitPriceCents: 1000,
        paymentSplit: [20, 80],
      },
    });
    expect(x.totals.one_time_cents).toBe(1500);
    expect(x.totals.deposit_cents).toBe(300);
    const lineId = x.lines[0].id;
    await expect(
      call(
        'update_quote_line',
        { quote_id: other.id, line_id: lineId, data: { label: 'Escaped' } },
        b,
      ),
    ).rejects.toThrow('not found');
    await expect(
      call('update_quote_line', { quote_id: q.id, line_id: lineId, data: { discountCents: 1600 } }),
    ).rejects.toThrow('Discount exceeds');
    expect((await call('get_quote', { quote_id: q.id })).totals.one_time_cents).toBe(1500);
    x = await call('update_quote_line', {
      quote_id: q.id,
      line_id: lineId,
      data: { discountBps: 1000 },
    });
    expect(x.totals.one_time_cents).toBe(1350);
    await call('remove_quote_line', { quote_id: q.id, line_id: lineId });
    expect((await call('get_quote', { quote_id: q.id })).lines).toHaveLength(0);
  });
  it('persists the delivery-partner choice and uses exact shared parts after nested schedule edits', async () => {
    const draft = await call('create_quote', {
      data: { customerId: customerA, title: 'Shared money fixture', vendorOfRecord: 'Synthetic' },
    });
    expect(draft.showDeliveryPartner).toBe(true);
    let updated = await call('update_quote', {
      quote_id: draft.id,
      data: { showDeliveryPartner: false },
    });
    expect(updated.showDeliveryPartner).toBe(false);
    updated = await call('add_quote_line', {
      quote_id: draft.id,
      data: { kind: 'milestone', label: 'Synthetic phase', unitPriceCents: 333 },
    });
    const lineId = updated.lines[0].id;
    expect(updated.totals.lines[0].payment_parts).toEqual([167, 166]);
    updated = await call('update_quote_line', {
      quote_id: draft.id,
      line_id: lineId,
      data: { milestone: { payment_split: [40, 30, 30] } },
    });
    expect(updated.lines[0].paymentSplit).toEqual([40, 30, 30]);
    expect(updated.totals.lines[0].payment_parts).toEqual([133, 100, 100]);
    await expect(
      call('update_quote_line', {
        quote_id: draft.id,
        line_id: lineId,
        data: { paymentSplit: [25, 75], milestone: { payment_split: [50, 50] } },
      }),
    ).rejects.toThrow('Conflicting payment splits');
    await expect(
      call('update_quote_line', {
        quote_id: draft.id,
        line_id: lineId,
        data: { paymentSplit: [20, 20] },
      }),
    ).rejects.toThrow('100');
    expect((await call('get_quote', { quote_id: draft.id })).totals.lines[0].payment_parts).toEqual(
      [133, 100, 100],
    );
  });
  it('options are atomic; foreign ids and conflicting selection are rejected', async () => {
    for (const selected of [false, false])
      await call('add_quote_line', {
        quote_id: q.id,
        data: {
          kind: 'option',
          label: 'Package',
          unitPriceCents: 100,
          optionGroup: { id: 'package', mode: 'exclusive' },
          selected,
        },
      });
    const lines = (await call('get_quote', { quote_id: q.id })).lines;
    await expect(
      call('set_quote_options', {
        quote_id: q.id,
        data: { selectedLineIds: lines.map((l: any) => l.id) },
      }),
    ).rejects.toThrow('exactly one');
    const x = await call('set_quote_options', {
      quote_id: q.id,
      data: { selectedLineIds: [lines[0].id] },
    });
    expect(x.totals.one_time_cents).toBe(100);
    await expect(
      call('set_quote_options', { quote_id: q.id, data: { selectedLineIds: [randomUUID()] } }),
    ).rejects.toThrow('does not belong');
  });
  it('costs, recipients, attachments and price book remain workspace-fenced', async () => {
    await call('add_quote_cost', {
      quote_id: q.id,
      data: { label: 'Synthetic direct cost', kind: 'other', amountCents: 1 },
    });
    await call('set_quote_recipients', {
      quote_id: q.id,
      data: {
        recipients: [{ name: 'Synthetic recipient', email: 'FIXTURE@example.invalid', role: 'to' }],
      },
    });
    await call('add_quote_attachment', {
      quote_id: q.id,
      data: { assetId: 'synthetic-asset', label: 'Fixture' },
    });
    const x = await call('get_quote', { quote_id: q.id });
    expect(x.recipients[0].email).toBe('fixture@example.invalid');
    expect(x.costs).toHaveLength(1);
    expect(x.attachments).toHaveLength(1);
    for (const t of tables) {
      const rows = await db.withWorkspace(b, user.keycloakId, (tx) =>
        tx.$queryRawUnsafe<any[]>(`SELECT * FROM "${t}" WHERE workspace_id=$1`, a),
      );
      expect(rows).toEqual([]);
    }
    expect(await call('list_price_book')).toEqual([]);
  });
  it('all eight tables reject cross-workspace writes with positive row controls', async () => {
    await owner.priceBookItem.create({
      data: {
        workspaceId: a,
        sku: 'synthetic',
        label: 'Synthetic item',
        kind: 'one_time',
        unit: 'item',
        defaultPriceCents: 1,
      },
    });
    for (const table of tables) {
      const existing = await owner.$queryRawUnsafe<any[]>(
        `SELECT * FROM "${table}" WHERE workspace_id=$1`,
        a,
      );
      expect(existing.length).toBeGreaterThan(0);
      expect(
        await db.withWorkspace(b, user.keycloakId, (tx) =>
          tx.$executeRawUnsafe(`UPDATE "${table}" SET workspace_id=$1 WHERE workspace_id=$1`, a),
        ),
      ).toBe(0);
      expect(
        await db
          .withWorkspace(b, user.keycloakId, (tx) =>
            tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE workspace_id=$1`, a),
          )
          .catch((e) => {
            if (table === 'quote_counters' && String(e).includes('permission denied')) return 0;
            throw e;
          }),
      ).toBe(0);
    }
    const attempts = [
      (tx: any) =>
        tx.quote.create({
          data: {
            workspaceId: a,
            customerId: customerA,
            number: 'Q-CROSS',
            title: 'Synthetic',
            validUntil: new Date(),
            vendorOfRecord: 'Synthetic',
            createdBy: 'fixture',
          },
        }),
      (tx: any) =>
        tx.quoteSection.create({
          data: { workspaceId: a, quoteId: q.id, kind: 'scope', heading: 'Synthetic' },
        }),
      (tx: any) =>
        tx.quoteLine.create({
          data: {
            workspaceId: a,
            quoteId: q.id,
            kind: 'one_time',
            label: 'Synthetic',
            unitPriceCents: 1,
          },
        }),
      (tx: any) =>
        tx.quoteCost.create({
          data: {
            workspaceId: a,
            quoteId: q.id,
            label: 'Synthetic',
            kind: 'other',
            amountCents: 1,
          },
        }),
      (tx: any) =>
        tx.quoteRecipient.create({
          data: {
            workspaceId: a,
            quoteId: q.id,
            name: 'Synthetic',
            email: 'other@example.invalid',
            role: 'to',
            addedBy: 'fixture',
          },
        }),
      (tx: any) =>
        tx.quoteAttachment.create({
          data: { workspaceId: a, quoteId: q.id, assetId: 'other-fixture', label: 'Synthetic' },
        }),
      (tx: any) => tx.quoteCounter.create({ data: { workspaceId: a, year: 9998, lastNumber: 1 } }),
      (tx: any) =>
        tx.priceBookItem.create({
          data: {
            workspaceId: a,
            sku: 'cross-fixture',
            label: 'Synthetic',
            kind: 'one_time',
            unit: 'item',
            defaultPriceCents: 1,
          },
        }),
    ];
    for (const attempt of attempts)
      await expect(db.withWorkspace(b, user.keycloakId, attempt)).rejects.toThrow();
  });
  it('actual REST routes reach the RLS-backed service and reject uneditable fields', async () => {
    const guard = {
      canActivate: (context: any) => {
        const req = context.switchToHttp().getRequest();
        req.user = user;
        req.workspaceId = a;
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [QuotesController],
      providers: [{ provide: QuotesService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(guard)
      .overrideGuard(WorkspaceMembershipGuard)
      .useValue(guard)
      .overrideGuard(WorkspaceRoleGuard)
      .useValue(guard)
      .compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    try {
      const response = await fetch(base + '/api/v1/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerId: customerA,
          title: 'HTTP fixture',
          vendorOfRecord: 'Synthetic',
        }),
      });
      expect(response.status).toBe(201);
      const created: any = await response.json();
      expect(created.number).toMatch(/^Q-/);
      const read = await fetch(base + '/api/v1/quotes/' + created.id);
      expect(read.status).toBe(200);
      const bad = await fetch(base + '/api/v1/quotes/' + created.id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'accepted' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('rejects locked and non-draft mutation', async () => {
    await owner.quote.update({ where: { id: q.id }, data: { lockedForSend: true } });
    await expect(call('update_quote', { quote_id: q.id, data: { title: 'No' } })).rejects.toThrow(
      'unlocked draft',
    );
    await owner.quote.update({
      where: { id: q.id },
      data: { lockedForSend: false, status: 'sent' },
    });
    await expect(
      call('add_quote_section', { quote_id: q.id, data: { kind: 'scope', heading: 'No' } }),
    ).rejects.toThrow('unlocked draft');
  });
  it('viewer query never fetches margin, private notes, recipients or pricing errors (A39)', async () => {
    const privateQuote = await call('create_quote', {
      data: {
        customerId: customerA,
        title: 'Synthetic private quote',
        vendorOfRecord: 'Synthetic vendor',
        internalNotesMd: 'PRIVATE-VIEWER-SENTINEL',
      },
    });
    await call('add_quote_section', {
      quote_id: privateQuote.id,
      data: { kind: 'scope', heading: 'Scope', internalBasisMd: 'PRIVATE-VIEWER-SENTINEL' },
    });
    const queries: string[] = [];
    const viewerDb = new PrismaService({
      datasources: { db: { url: appUrl } },
      log: [{ emit: 'event', level: 'query' }],
    });
    (viewerDb as any).$on('query', (e: any) => queries.push(e.query));
    const viewer = new QuotesService(
      viewerDb,
      { get: () => '1' } as any,
      { resolveAuthorized: async () => a } as any,
      { roleInWorkspace: async () => WorkspaceRole.VIEWER } as any,
    );
    try {
      const view = await viewer.execute(user, a, 'get_quote', { quote_id: privateQuote.id });
      expect(JSON.stringify(view)).not.toContain('PRIVATE-VIEWER-SENTINEL');
      for (const field of ['costs', 'splitRule', 'internalNotesMd', 'recipients'])
        expect(view).not.toHaveProperty(field);
      expect(view.totals).not.toHaveProperty('line_errors');
      expect(view.totals).not.toHaveProperty('option_group_errors');
      const sql = queries.join(' ');
      for (const column of [
        'internal_notes_md',
        'internal_basis_md',
        'split_rule',
        'quote_costs',
        'quote_recipients',
      ])
        expect(sql).not.toContain(column);
      expect(await owner.quoteEvent.count({ where: { quoteId: privateQuote.id } })).toBe(2);
      expect(
        await owner.auditLog.count({ where: { workspaceId: a, resourceId: privateQuote.id } }),
      ).toBe(2);
    } finally {
      await viewerDb.$disconnect();
    }
  });
});
