import { randomUUID, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { QuotesLifecycleService, QuoteNotAvailable } from './quotes-lifecycle.service';
import { PersistedQuotePublicSource } from './quote-public.source';
import { QuotesRenderPublicController } from '../quotes-render/quotes-render.controller';
import { QuotesRenderService } from '../quotes-render/quotes-render.service';
import { QuotePublicSource } from '../quotes-render/quotes-render.port';
import { toPublishedQuoteView } from './quote-published-view';
import { sha256 } from './quote-secrets';

const appUrl = process.env.CUSTOMER_OPS_RLS_TEST_DATABASE_URL;
const describeDb = appUrl ? describe : describe.skip;
describeDb('M2 lifecycle through real PostgreSQL RLS and public HTTP', () => {
  let db: PrismaService, owner: PrismaClient, service: QuotesLifecycleService;
  const ws = randomUUID(),
    other = randomUUID(),
    user = { id: 'fixture', ucUid: 'fixture' } as any;
  const settings: Record<string, string> = {
    QUOTES_ENABLED: '1',
    QUOTES_ACCEPTANCE_SECRET: randomBytes(32).toString('hex'),
    QUOTES_COOKIE_SECRET: randomBytes(32).toString('hex'),
    QUOTES_PUBLIC_BASE_URL: 'https://quote.example.invalid/api/v1/public/quotes',
    QUOTES_TRUSTED_PROXY_HOPS: '0',
    QUOTES_TOKEN_RATE_LIMIT: '1000',
  };
  const config = { get: (key: string) => settings[key] } as ConfigService;
  const messages: any[] = [],
    items = new Map<string, any>();
  const email = {
    isConfigured: () => true,
    checkEntitlement: () => ({ allowed: true }),
    composeEmail: jest.fn(async (_ctx: any, input: any) => {
      const id = randomUUID();
      messages.push({ ...input, id });
      if (input.mode === 'draft')
        items.set(id, { id: randomUUID(), messageId: id, status: 'pending' });
      return {
        id,
        externalRef: input.externalRef,
        mode: input.mode,
        status: input.mode === 'draft' ? 'draft' : 'queued',
      };
    }),
    findAgentInboxItem: jest.fn(async (_ctx: any, id: string) => items.get(id) ?? null),
    getAgentInboxItem: jest.fn(
      async (_ctx: any, id: string) => [...items.values()].find((v) => v.id === id) ?? null,
    ),
  };
  const workspaces = {
    resolveAuthorized: async (_u: any, id: string) => {
      if (id !== ws) throw Error('Not a workspace member');
      return ws;
    },
    effectiveEntitlements: async () => ['customer-ops', 'email-ops'],
    workspaceEntitlements: async () => ['customer-ops', 'email-ops'],
    assertAgentsNotPaused: async () => {},
  };
  const presentation = {
    forSend: async () => ({
      customer: { display_name: 'Synthetic recipient', org_name: null, attention: null },
      letterhead: { legal_name: '', address_lines: [] },
    }),
    letterhead: async () => ({ letterhead: { legal_name: 'Synthetic vendor', address_lines: [] } }),
  };
  const meta = (key = randomUUID()) => ({
    ip: '127.0.0.1',
    ua: 'synthetic test',
    idempotency_key: key,
  });
  const accept = {
    name: 'Synthetic recipient',
    email: 'recipient@example.invalid',
    title: null,
    accepted: true,
    selected_line_ids: [],
  };
  async function quote() {
    const customer = await owner.customer.create({
      data: { workspaceId: ws, contactId: randomUUID(), stage: 'LEAD' },
    });
    const q = await owner.quote.create({
      data: {
        workspaceId: ws,
        customerId: customer.id,
        number: 'Q-' + randomUUID(),
        title: 'Synthetic proposal',
        vendorOfRecord: 'Synthetic vendor',
        validUntil: new Date(Date.now() + 86400000),
        createdBy: 'fixture',
        internalNotesMd: 'PRIVATE-SENTINEL',
        splitRule: { notes: 'PRIVATE-SENTINEL' },
      },
    });
    await owner.quoteLine.create({
      data: {
        workspaceId: ws,
        quoteId: q.id,
        kind: 'one_time',
        label: 'Synthetic deliverable',
        unitPriceCents: 333,
      },
    });
    await owner.quoteRecipient.create({
      data: {
        workspaceId: ws,
        quoteId: q.id,
        email: accept.email,
        role: 'to',
        name: 'Synthetic recipient',
        addedBy: 'fixture',
      },
    });
    return q;
  }
  async function send(q: any, approved = false) {
    const result = await service.send(user, ws, q.id, randomUUID());
    const message = messages.find((m) => m.externalRef === 'quote-send:' + result.versionId);
    const token = message.body.split('/').at(-1);
    if (approved) {
      items.get(message.id).status = 'approved';
      await service.observe(ws, result.versionId);
    }
    return { ...result, token, message };
  }
  async function begin(token: string) {
    const result = await service.begin(token, accept, meta());
    expect(result.ok).toBe(true);
    const pending = (result as any).pending_id;
    const message = messages.find((m) => m.externalRef === 'quote-code:' + pending);
    return { pending, code: message.body.match(/\b\d{6}\b/)[0], result };
  }
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: appUrl } } });
    owner = new PrismaClient({
      datasources: { db: { url: process.env.CUSTOMER_OPS_RLS_OWNER_DATABASE_URL } },
    });
    for (const id of [ws, other])
      await owner.workspace.create({
        data: { id, slug: 'lifecycle-' + id, displayName: 'Synthetic lifecycle workspace' },
      });
    service = new QuotesLifecycleService(
      db,
      config,
      workspaces as any,
      { roleInWorkspace: async () => 'OWNER' } as any,
      email as any,
      presentation as any,
    );
  });
  afterAll(async () => {
    if (owner) {
      for (const table of [
        'quote_events',
        'quote_pending_acceptances',
        'quote_share_tokens',
        'quote_versions',
        'quote_recipients',
        'quote_lines',
        'quotes',
      ])
        await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE workspace_id=$1`, ws);
      await owner.auditLog.deleteMany({ where: { workspaceId: ws } });
      await owner.customer.deleteMany({ where: { workspaceId: ws } });
      await owner.workspace.deleteMany({ where: { id: { in: [ws, other] } } });
      await owner.$disconnect();
    }
    if (db) await db.$disconnect();
  });
  it('drafts one immutable version and inactive token, with no private snapshot fields or legal copy', async () => {
    const q = await quote(),
      key = randomUUID(),
      first = await service.send(user, ws, q.id, key);
    await service.send(user, ws, q.id, key);
    expect(messages.filter((m) => m.externalRef === 'quote-send:' + first.versionId)).toHaveLength(
      1,
    );
    const stored = await owner.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(stored).toMatchObject({
      status: 'draft',
      lockedForSend: true,
      sendPendingApproval: true,
    });
    const v = await owner.quoteVersion.findUniqueOrThrow({ where: { id: first.versionId } });
    const t = await owner.quoteShareToken.findFirstOrThrow({ where: { versionId: v.id } });
    const historical = structuredClone(v.snapshot) as any;
    historical.totals.one_time_cents = 101;
    historical.totals.lines[0].amount_cents = 101;
    const published = toPublishedQuoteView(historical, { state: 'open' });
    expect(published.totals.one_time_cents).toBe(101);
    expect(published.sections[0].lines[0].amount_cents).toBe(101);
    expect(t.activatedAt).toBeNull();
    expect(t.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(t.expiresAt).toEqual(q.validUntil);
    expect(JSON.stringify(v.snapshot)).not.toContain('PRIVATE-SENTINEL');
    expect((v.snapshot as any).letterhead).toEqual({ legal_name: '', address_lines: [] });
  });
  it('pending and failed observations reveal no document; approved observation commits exactly once', async () => {
    const q = await quote(),
      s = await send(q);
    await expect(service.lookup(s.token, meta())).rejects.toBeInstanceOf(QuoteNotAvailable);
    email.getAgentInboxItem.mockRejectedValueOnce(Error('offline'));
    await expect(service.lookup(s.token, meta())).rejects.toBeInstanceOf(QuoteNotAvailable);
    expect((await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('draft');
    items.get(s.message.id).status = 'approved';
    const view = await service.lookup(s.token, meta());
    expect(view.found).toBe(true);
    await Promise.all([service.observe(ws, s.versionId), service.observe(ws, s.versionId)]);
    expect(await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({
      status: 'viewed',
      lockedForSend: false,
      sendPendingApproval: false,
    });
    expect((await owner.customer.findUniqueOrThrow({ where: { id: q.customerId } })).stage).toBe(
      'PROSPECT',
    );
    expect(await owner.quoteEvent.count({ where: { quoteId: q.id, kind: 'sent' } })).toBe(1);
    expect(await owner.quoteEvent.count({ where: { quoteId: q.id, kind: 'send_approved' } })).toBe(
      1,
    );
  });
  it('rejects a mismatched inbox observation and revokes on an observed rejection', async () => {
    const q = await quote(),
      s = await send(q);
    email.getAgentInboxItem.mockResolvedValueOnce({
      id: items.get(s.message.id).id,
      messageId: 'another-message',
      status: 'approved',
    });
    await expect(service.lookup(s.token, meta())).rejects.toBeInstanceOf(QuoteNotAvailable);
    items.get(s.message.id).status = 'rejected';
    await service.observe(ws, s.versionId);
    expect(await service.lookup(s.token, meta())).toEqual({ found: false });
    expect(await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({
      status: 'draft',
      lockedForSend: false,
      sendPendingApproval: false,
    });
    expect(
      (await owner.quoteShareToken.findFirstOrThrow({ where: { versionId: s.versionId } }))
        .revokedAt,
    ).not.toBeNull();
    expect(await owner.quoteEvent.count({ where: { quoteId: q.id, kind: 'send_rejected' } })).toBe(
      1,
    );
  });
  it('failed draft composition revokes and unlocks without activation', async () => {
    const q = await quote();
    email.composeEmail.mockRejectedValueOnce(Error('offline'));
    await expect(service.send(user, ws, q.id, randomUUID())).rejects.toThrow('not confirmed');
    expect(await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({
      status: 'draft',
      lockedForSend: false,
      sendPendingApproval: false,
    });
    expect(
      await owner.quoteShareToken.findFirstOrThrow({ where: { quoteId: q.id } }),
    ).toMatchObject({ activatedAt: null, revokedAt: expect.any(Date) });
  });
  it('requires recipient and idempotency; begin never accepts; confirmation is atomic under concurrency', async () => {
    const q = await quote(),
      s = await send(q, true);
    expect(await service.begin(s.token, accept, { ip: null, ua: null })).toMatchObject({
      status: 400,
    });
    expect(
      await service.begin(s.token, { ...accept, email: 'stranger@example.invalid' }, meta()),
    ).toMatchObject({ status: 403 });
    const b = await begin(s.token);
    expect((await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('sent');
    expect((await owner.customer.findUniqueOrThrow({ where: { id: q.customerId } })).stage).toBe(
      'PROSPECT',
    );
    const m = meta(),
      p = { pending_id: b.pending, code: b.code };
    expect(await service.confirm(s.token, { ...p, pending_id: null }, m)).toMatchObject({
      status: 400,
    });
    const [a, c] = await Promise.all([
      service.confirm(s.token, p, m),
      service.confirm(s.token, p, m),
    ]);
    expect(a).toMatchObject({ ok: true, status: 200 });
    expect(c).toEqual(a);
    expect((await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('accepted');
    expect((await owner.customer.findUniqueOrThrow({ where: { id: q.customerId } })).stage).toBe(
      'CUSTOMER',
    );
    expect(await owner.quoteEvent.count({ where: { quoteId: q.id, kind: 'quote.accepted' } })).toBe(
      1,
    );
    const v = await owner.quoteVersion.findUniqueOrThrow({ where: { id: s.versionId } });
    expect(v.acceptedSnapshot).not.toBeNull();
    await expect(
      db.withWorkspace(ws, null, (tx) =>
        tx.quoteVersion.update({ where: { id: v.id }, data: { acceptedSnapshot: {} } }),
      ),
    ).rejects.toThrow();
  });
  it('replayed wrong codes consume one attempt; five distinct wrong codes void even a correct next code', async () => {
    const q = await quote(),
      s = await send(q, true),
      b = await begin(s.token),
      wrong = b.code === '000000' ? '000001' : '000000';
    const m = meta(),
      p = { pending_id: b.pending, code: wrong };
    const first = await service.confirm(s.token, p, m);
    expect(first).toMatchObject({ status: 400, attempts_left: 4 });
    expect(await service.confirm(s.token, p, m)).toEqual(first);
    const evidence = await owner.quotePendingAcceptance.findUniqueOrThrow({
      where: { id: b.pending },
    });
    expect((evidence.confirmReceipts as any[])[0].fingerprint).not.toBe(sha256(JSON.stringify(p)));
    expect(await service.confirm(s.token, { ...p, code: b.code }, m)).toMatchObject({
      status: 409,
    });
    for (let n = 2; n <= 5; n++)
      expect(await service.confirm(s.token, p, meta())).toMatchObject({ attempts_left: 5 - n });
    expect(await service.confirm(s.token, { ...p, code: b.code }, meta())).toMatchObject({
      status: 410,
    });
    expect((await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('sent');
  });
  it('binds pending records to their token and rejects revoked, expired and superseded POSTs', async () => {
    const q = await quote(),
      s = await send(q, true),
      b = await begin(s.token),
      q2 = await quote(),
      s2 = await send(q2, true);
    expect(
      await service.confirm(s2.token, { pending_id: b.pending, code: b.code }, meta()),
    ).toMatchObject({ status: 404 });
    await service.supersede(user, ws, q.id);
    expect(
      await service.confirm(s.token, { pending_id: b.pending, code: b.code }, meta()),
    ).toMatchObject({ status: 409 });
    expect(await service.begin(s.token, accept, meta())).toMatchObject({ status: 409 });
    const t = await owner.quoteShareToken.findFirstOrThrow({ where: { versionId: s2.versionId } });
    await service.revoke(user, ws, q2.id, t.id);
    expect(await service.begin(s2.token, accept, meta())).toMatchObject({ status: 410 });
    const q3 = await quote(),
      s3 = await send(q3, true);
    await owner.quote.update({ where: { id: q3.id }, data: { status: 'expired' } });
    expect(await service.begin(s3.token, accept, meta())).toMatchObject({ status: 410 });
    expect(
      await db.withWorkspace(other, null, (tx) =>
        tx.quoteShareToken.findFirst({ where: { tokenHash: sha256(s.token) } }),
      ),
    ).toBeNull();
    await expect(service.send(user, other, q.id, randomUUID())).rejects.toThrow(
      'Not a workspace member',
    );
  });
  it('late failure or repeated revocation of an older draft cannot unlock a newer send', async () => {
    const q = await quote();
    let finish!: (value: any) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    email.composeEmail.mockImplementationOnce(async () => {
      entered();
      return new Promise((resolve) => (finish = resolve));
    });
    const old = service.send(user, ws, q.id, randomUUID()).catch((error) => error);
    await ready;
    const token = await owner.quoteShareToken.findFirstOrThrow({ where: { quoteId: q.id } });
    await service.revoke(user, ws, q.id, token.id);
    const current = await send(q);
    finish(null);
    await old;
    expect(await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({
      lockedForSend: true,
      sendPendingApproval: true,
      currentVersionNo: 2,
    });
    await service.revoke(user, ws, q.id, token.id);
    expect(await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({
      lockedForSend: true,
      sendPendingApproval: true,
    });
    items.get(current.message.id).status = 'approved';
    await service.observe(ws, current.versionId);
    expect(await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({
      status: 'sent',
      lockedForSend: false,
    });
  });
  it('owner-recorded acceptance is explicitly attributed and replay-safe', async () => {
    const q = await quote(),
      s = await send(q, true),
      key = randomUUID();
    const payload = {
      ...accept,
      when: new Date().toISOString(),
      how: 'Synthetic call confirmation',
    };
    delete (payload as any).accepted;
    const accepted = await service.recordAcceptance(user, ws, q.id, payload, key);
    expect(await service.recordAcceptance(user, ws, q.id, payload, key)).toEqual(accepted);
    const view = await service.lookup(s.token, meta());
    expect(view.found && view.view.acceptance.accepted_by?.recorded_by_member).toBeTruthy();
    expect(
      await owner.quoteEvent.count({ where: { quoteId: q.id, kind: 'owner_recorded_acceptance' } }),
    ).toBe(1);
    const memberService = new QuotesLifecycleService(
      db,
      config,
      workspaces as any,
      { roleInWorkspace: async () => 'MEMBER' } as any,
      email as any,
      presentation as any,
    );
    await expect(
      memberService.recordAcceptance(user, ws, q.id, payload, randomUUID()),
    ).rejects.toThrow('owner required');
  });
  it('reconciles approved drafts and expires commercial status idempotently', async () => {
    const q = await quote(),
      s = await send(q);
    items.get(s.message.id).status = 'approved';
    await service.reconcile();
    expect((await owner.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('sent');
    await owner.quote.update({
      where: { id: q.id },
      data: { validUntil: new Date(Date.now() - 1000) },
    });
    await service.expire();
    await service.expire();
    expect(await owner.quoteEvent.count({ where: { quoteId: q.id, kind: 'expired' } })).toBe(1);
  });
  it('serves a neutral HTTP page before approval, then real HTML and cookie-bound acceptance routes', async () => {
    const q = await quote(),
      s = await send(q),
      source = new PersistedQuotePublicSource(service);
    const render = new QuotesRenderService(
      config,
      source,
      { getBrandTokens: async () => null } as any,
      { isAvailable: () => false } as any,
    );
    const module = await Test.createTestingModule({
      controllers: [QuotesRenderPublicController],
      providers: [
        { provide: QuotePublicSource, useValue: source },
        { provide: QuotesRenderService, useValue: render },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const root = (await app.getUrl()) + '/api/v1/public/quotes/' + s.token;
    try {
      const pending = await fetch(root);
      expect(pending.status).toBe(503);
      const html = await pending.text();
      if (process.env.QUOTES_EVIDENCE_DIR) {
        const fs = require('fs');
        fs.mkdirSync(process.env.QUOTES_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(process.env.QUOTES_EVIDENCE_DIR + '/pending.html', html);
      }
      expect(html).toContain('Not available yet');
      expect(html).not.toContain(q.title);
      items.get(s.message.id).status = 'approved';
      const page = await fetch(root);
      expect(page.status).toBe(200);
      const document = await page.text();
      if (process.env.QUOTES_EVIDENCE_DIR)
        require('fs').writeFileSync(
          process.env.QUOTES_EVIDENCE_DIR + '/approved.html',
          document.split(s.token).join('synthetic-share-link'),
        );
      expect(document).toContain('Synthetic proposal');
      expect(document).not.toContain('PRIVATE-SENTINEL');
      const cookie = page.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      const body = JSON.stringify(accept),
        headers = { 'content-type': 'application/json', 'idempotency-key': randomUUID() };
      expect((await fetch(root + '/accept', { method: 'POST', headers, body })).status).toBe(428);
      const response = await fetch(root + '/accept', {
        method: 'POST',
        headers: { ...headers, cookie: cookie.split(';')[0] },
        body,
      });
      expect(response.status).toBe(202);
      const json = (await response.json()) as any,
        mail = messages.find((m) => m.externalRef === 'quote-code:' + json.pending_id);
      expect(
        (
          await fetch(root + '/accept/confirm', {
            method: 'POST',
            headers: { ...headers, 'idempotency-key': randomUUID(), cookie: cookie.split(';')[0] },
            body: JSON.stringify({
              pending_id: json.pending_id,
              code: mail.body.match(/\b\d{6}\b/)[0],
            }),
          })
        ).status,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
