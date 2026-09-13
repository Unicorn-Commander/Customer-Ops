import { ConfigService } from '@nestjs/config';
import { AccountingOpsClient } from './accounting-ops.client';
import { FederationContext } from './accounting-ops.port';
import { InvoiceDraft } from './accounting-ops.types';
import { BrigadeTokenSource } from '../common/federation/brigade-token-source';

/**
 * The federation workspace map (added with the per-workspace map in 0d09be3).
 * `resolveSync` returning null means "this workspace has no explicit mapping for
 * that app", and every client then falls back to ctx.workspaceId — i.e. exactly
 * the behaviour these specs were written against. Override per-test if a case
 * ever needs a real mapping.
 */
function makeFedMap(mapped: string | null = null) {
  return { resolveSync: jest.fn().mockReturnValue(mapped) } as any;
}


/** These tests exercise STATIC auth mode (AO_SERVICE_TOKEN forwarded), so the
 *  Brigade source is never reached; a stub that returns null suffices. The
 *  brigade-sts path is proven live, not unit-mocked (mirrors Contact-Ops). */
function makeBrigade(): BrigadeTokenSource {
  return { exchangedToken: jest.fn().mockResolvedValue(null) } as unknown as BrigadeTokenSource;
}

/**
 * The Accounting-Ops federation client speaks JSON-RPC 2.0 to AO's `POST /mcp`
 * (create_invoice_from_draft / get_invoice). Accounting-Ops is MOCKED here via a
 * fake global.fetch — AO is never running. These pin the brief's requirements:
 *   - create_invoice_from_draft argument mapping (customer{}, line_items[],
 *     money as decimal STRINGS, the deterministic external_ref/source) + the AO
 *     invoice-view → FederatedInvoice mapping,
 *   - IDEMPOTENCY on external_ref: the same (source, ref) drives the same AO
 *     tool args; AO returns the same invoice (no second journal entry) — we
 *     assert the wire carries the stable ref and the mapped result is stable,
 *   - the DUAL-SKU entitlement gate: PASS only with both customer-ops AND
 *     accounting-ops; DENY otherwise; OPEN bootstrap (UC_ENTITLEMENT_MODE=open)
 *     bypasses with a WARN; a denied create makes NO fetch,
 *   - DEGRADE-CLEAN: unset AO_BASE_URL → isConfigured()=false + null, no fetch,
 *   - the get_invoice POLL by (external_source, external_ref) and by id,
 *   - transport/HTTP/tool errors → null, never throw (federation best-effort).
 */

const ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: ['customer-ops', 'accounting-ops'],
};
const HALF_ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: ['customer-ops'], // missing accounting-ops
};
const NOT_ENTITLED: FederationContext = {
  workspaceId: 'ws-aaaa',
  ucUid: 'uc-uid-1',
  entitlements: [],
};

const DRAFT: InvoiceDraft = {
  entityId: 'entity-1',
  externalSource: 'customer-ops',
  externalRef: 'cust:cust-1:idem-key-123',
  customer: { name: 'Acme Co', contactId: 'contact-42', email: 'ap@acme.test' },
  lineItems: [
    { description: 'Consulting', quantity: '10', unitPrice: '150.0000' },
    { description: 'License', quantity: '1', unitPrice: '500', taxAmount: '40.0000' },
  ],
  currency: 'USD',
  dueDate: '2026-07-01',
};

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  // The client reads the body via `res.text()` then SSE/JSON-parses it
  // (callTool -> parseRpc(await res.text())), so the mock must expose text().
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A JSON-RPC tools/call success envelope wrapping structuredContent. */
function rpcOk(structured: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: false,
      structuredContent: structured,
      content: [{ type: 'text', text: JSON.stringify(structured) }],
    },
  };
}

/** A representative AO invoice view (money as DECIMAL STRINGS, as AO emits). */
function aoInvoiceView(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'INV-2026-0001',
    status: 'sent',
    currency: 'USD',
    subtotal: '2000.0000',
    tax_total: '40.0000',
    total: '2040.0000',
    balance_due: '2040.0000',
    issue_date: '2026-06-03',
    due_date: '2026-07-01',
    external_source: 'customer-ops',
    external_ref: 'cust:cust-1:idem-key-123',
    pdf_url: '/api/workspaces/ws-aaaa/invoices/inv-1/pdf',
    hosted_pay_url: null,
    ...over,
  };
}

const CONFIGURED_ENFORCE = {
  AO_BASE_URL: 'https://acct.example.test/',
  AO_SERVICE_TOKEN: 'svc-token-ao',
  UC_ENTITLEMENT_MODE: 'enforce',
};

describe('AccountingOpsClient (Accounting-Ops MOCKED)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: AO_BASE_URL unset (dormant)', () => {
    const client = new AccountingOpsClient(makeConfig({}), makeBrigade(), makeFedMap());

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('createInvoice returns null WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.createInvoice(ENTITLED, DRAFT)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('getInvoiceByRef / getInvoiceById return null without fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(
        client.getInvoiceByRef(ENTITLED, 'customer-ops', 'cust:cust-1:k'),
      ).resolves.toBeNull();
      await expect(client.getInvoiceById(ENTITLED, 'inv-1')).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('dual-SKU entitlement gate', () => {
    it('PASS only when BOTH customer-ops AND accounting-ops are present (enforce)', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      const pass = client.checkEntitlement(ENTITLED);
      expect(pass).toMatchObject({ allowed: true, mode: 'enforce' });
    });

    it('DENY when accounting-ops is missing (enforce)', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      const deny = client.checkEntitlement(HALF_ENTITLED);
      expect(deny.allowed).toBe(false);
      expect(deny.mode).toBe('enforce');
    });

    it('DENY when no entitlements at all (enforce)', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      expect(client.checkEntitlement(NOT_ENTITLED).allowed).toBe(false);
    });

    it('a denied createInvoice makes NO fetch (defense-in-depth)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      await expect(client.createInvoice(HALF_ENTITLED, DRAFT)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('OPEN bootstrap (UC_ENTITLEMENT_MODE=open) bypasses the dual-SKU check', () => {
      const client = new AccountingOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, UC_ENTITLEMENT_MODE: 'open' }),
        makeBrigade(), makeFedMap()
      );
      const decision = client.checkEntitlement(NOT_ENTITLED);
      expect(decision).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('falls back to AO_CROSS_APP_ENTITLEMENT_MODE when UC_ENTITLEMENT_MODE is unset', () => {
      const client = new AccountingOpsClient(
        makeConfig({
          AO_BASE_URL: 'https://acct.example.test',
          AO_CROSS_APP_ENTITLEMENT_MODE: 'open',
        }),
        makeBrigade(), makeFedMap()
      );
      expect(client.checkEntitlement(NOT_ENTITLED)).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('accepts SKU aliases (e.g. accounting_ops / AO) on read', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      const aliased: FederationContext = {
        workspaceId: 'ws-aaaa',
        ucUid: 'u',
        entitlements: ['customer_ops', 'AO'],
      };
      expect(client.checkEntitlement(aliased).allowed).toBe(true);
    });
  });

  describe('createInvoice (entitled, configured)', () => {
    it('posts create_invoice_from_draft with the mapped args (money as STRINGS) and maps the view', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());

      const invoice = await client.createInvoice(ENTITLED, DRAFT);

      // URL + method + JSON-RPC envelope. Trailing slash is intentional — the
      // client POSTs to {BASE}/mcp/ for the stateless FastMCP seam.
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://acct.example.test/mcp/');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'create_invoice_from_draft' },
      });
      // Workspace forwarded as the wire address (header) + service token.
      expect(init.headers['X-Workspace-Id']).toBe('ws-aaaa');
      expect(init.headers['Authorization']).toBe('Bearer svc-token-ao');

      // The deterministic idempotency tuple is on the wire.
      const args = body.params.arguments;
      expect(args.workspace_id).toBe('ws-aaaa');
      expect(args.entity_id).toBe('entity-1');
      expect(args.external_source).toBe('customer-ops');
      expect(args.external_ref).toBe('cust:cust-1:idem-key-123');
      // Customer (contactId travels as contact_id — a thin reference, not a copy).
      expect(args.customer).toEqual({ name: 'Acme Co', contact_id: 'contact-42', email: 'ap@acme.test' });
      // Lines: money/quantity remain decimal STRINGS, snake_cased keys.
      expect(args.line_items).toEqual([
        { description: 'Consulting', quantity: '10', unit_price: '150.0000' },
        { description: 'License', quantity: '1', unit_price: '500', tax_amount: '40.0000' },
      ]);
      expect(args.currency).toBe('USD');
      expect(args.due_date).toBe('2026-07-01');
      expect(args.auto_send).toBe(false);

      // The AO view maps to FederatedInvoice with money as strings.
      expect(invoice).toMatchObject({
        id: 'inv-1',
        invoiceNumber: 'INV-2026-0001',
        status: 'sent',
        total: '2040.0000',
        balanceDue: '2040.0000',
        externalRef: 'cust:cust-1:idem-key-123',
        pdfUrl: '/api/workspaces/ws-aaaa/invoices/inv-1/pdf',
      });
      // Money is a string, never a float.
      expect(typeof invoice?.total).toBe('string');
    });

    it('IDEMPOTENT on external_ref: the same draft yields the same AO invoice (no divergence)', async () => {
      // AO is idempotent on (workspace, source, ref): a repeat returns the SAME
      // existing invoice. We model that — both calls send the SAME external_ref
      // and AO returns the SAME view. The client must surface it stably.
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());

      const first = await client.createInvoice(ENTITLED, DRAFT);
      const second = await client.createInvoice(ENTITLED, DRAFT);

      const ref1 = JSON.parse(fetchSpy.mock.calls[0][1].body).params.arguments.external_ref;
      const ref2 = JSON.parse(fetchSpy.mock.calls[1][1].body).params.arguments.external_ref;
      expect(ref1).toBe('cust:cust-1:idem-key-123');
      expect(ref2).toBe(ref1); // same idempotency key on the wire
      // Same AO invoice id back both times (AO posted no second journal entry).
      expect(first?.id).toBe('inv-1');
      expect(second?.id).toBe('inv-1');
      expect(second).toEqual(first);
    });

    it('returns null (never throws) on a transport error — link persists upstream', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      await expect(client.createInvoice(ENTITLED, DRAFT)).resolves.toBeNull();
    });

    it('returns null on a JSON-RPC error envelope (e.g. AO EntitlementError)', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'denied' } }),
        ) as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      await expect(client.createInvoice(ENTITLED, DRAFT)).resolves.toBeNull();
    });

    it('returns null when the tool result is isError', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'invoice not found' }] },
        }),
      ) as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      await expect(client.createInvoice(ENTITLED, DRAFT)).resolves.toBeNull();
    });
  });

  describe('get_invoice poll', () => {
    it('getInvoiceByRef polls by (external_source, external_ref) and maps status/balance', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView({ status: 'partial', balance_due: '1000.0000' }))));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());

      const inv = await client.getInvoiceByRef(ENTITLED, 'customer-ops', 'cust:cust-1:idem-key-123');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.name).toBe('get_invoice');
      expect(body.params.arguments).toEqual({
        workspace_id: 'ws-aaaa',
        external_source: 'customer-ops',
        external_ref: 'cust:cust-1:idem-key-123',
      });
      expect(inv).toMatchObject({ status: 'partial', balanceDue: '1000.0000' });
    });

    it('getInvoiceById polls by AO invoice id', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView({ status: 'paid', balance_due: '0.0000' }))));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());

      const inv = await client.getInvoiceById(ENTITLED, 'inv-1');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments).toEqual({ workspace_id: 'ws-aaaa', invoice_id: 'inv-1' });
      expect(inv).toMatchObject({ status: 'paid', balanceDue: '0.0000' });
    });

    it('poll does NOT require the dual SKU (reads are viewer-level on AO)', async () => {
      // A workspace with no entitlement claim can still poll existing invoices.
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      const inv = await client.getInvoiceByRef(NOT_ENTITLED, 'customer-ops', 'cust:cust-1:idem-key-123');
      expect(inv?.id).toBe('inv-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null (never throws) on HTTP 500', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 500)) as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), makeBrigade(), makeFedMap());
      await expect(client.getInvoiceById(ENTITLED, 'inv-1')).resolves.toBeNull();
    });
  });

  describe('auth mode (AO_AUTH_MODE)', () => {
    it('STATIC (default / unset): forwards AO_SERVICE_TOKEN, never touches Brigade', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const brigade = makeBrigade();
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE), brigade, makeFedMap());

      await client.getInvoiceById(ENTITLED, 'inv-1');

      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer svc-token-ao');
      expect(brigade.exchangedToken).not.toHaveBeenCalled();
    });

    it('BRIGADE-STS: mints aud=accounting-ops + forwards the exchanged bearer (not the static token)', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const brigade = {
        exchangedToken: jest.fn().mockResolvedValue('brigade-minted-ao'),
      } as unknown as BrigadeTokenSource;
      const client = new AccountingOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, AO_AUTH_MODE: 'brigade-sts' }),
        brigade, makeFedMap()
      );

      await client.getInvoiceById(ENTITLED, 'inv-1');

      expect(brigade.exchangedToken).toHaveBeenCalledWith({
        audience: 'accounting-ops',
        scope: 'invoices:read invoices:write',
        workspaceId: 'ws-aaaa',
      });
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer brigade-minted-ao');
    });

    it('BRIGADE-STS honors AO_AUDIENCE override + degrades clean (no bearer) when the exchange fails', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const brigade = makeBrigade(); // exchangedToken → null (exchange failed)
      const client = new AccountingOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, AO_AUTH_MODE: 'brigade-sts', AO_AUDIENCE: 'ao-prod' }),
        brigade, makeFedMap()
      );

      await client.getInvoiceById(ENTITLED, 'inv-1');

      expect(brigade.exchangedToken).toHaveBeenCalledWith(
        expect.objectContaining({ audience: 'ao-prod' }),
      );
      // Exchange failed → no Authorization header, but the call still went out.
      expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBeUndefined();
      expect(fetchSpy.mock.calls[0][1].headers['X-Workspace-Id']).toBe('ws-aaaa');
    });
  });
  describe('A51 direct client credentials', () => {
    function setup(token: string | null = 'direct-fixture') {
      const brigade = {
        exchangedToken: jest.fn().mockResolvedValue('read-fixture'),
        clientCredentialsToken: jest.fn().mockResolvedValue(token),
      };
      const client = new AccountingOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, AO_AUTH_MODE: 'client-credentials' }),
        brigade as any, makeFedMap('mapped-ws'),
      );
      global.fetch = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      return { client, brigade };
    }
    it('writes with the direct token and mapped workspace, without exchange', async () => {
      const { client, brigade } = setup();
      await client.createInvoice(ENTITLED, DRAFT);
      expect(brigade.clientCredentialsToken).toHaveBeenCalledWith('invoices:write');
      expect(brigade.exchangedToken).not.toHaveBeenCalled();
      const init = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(init.headers.Authorization).toBe('Bearer direct-fixture');
      expect(init.headers['X-Workspace-Id']).toBe('mapped-ws');
      expect(JSON.parse(init.body).params.arguments.workspace_id).toBe('mapped-ws');
    });
    it('does not fall back to static or exchanged tokens after mint failure', async () => {
      const { client, brigade } = setup(null);
      expect(await client.createInvoice(ENTITLED, DRAFT)).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(brigade.exchangedToken).not.toHaveBeenCalled();
    });
    it('keeps the entitlement check ahead of token minting', async () => {
      const { client, brigade } = setup();
      expect(await client.createInvoice(NOT_ENTITLED, DRAFT)).toBeNull();
      expect(brigade.clientCredentialsToken).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
    it('keeps entity reads on the Brigade read rail', async () => {
      const { client, brigade } = setup();
      global.fetch = jest.fn().mockResolvedValue(new Response('[]'));
      await client.getEntity('local-ws', 'entity');
      expect(brigade.exchangedToken).toHaveBeenCalledWith({ audience: 'accounting-ops', scope: 'invoices:read', workspaceId: 'mapped-ws' });
      expect(brigade.clientCredentialsToken).not.toHaveBeenCalled();
      expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer read-fixture');
    });
    it('polls with only the exchanged read scope', async () => {
      const { client, brigade } = setup();
      await client.getInvoiceById(ENTITLED, 'invoice');
      expect(brigade.exchangedToken).toHaveBeenCalledWith({ audience: 'accounting-ops', scope: 'invoices:read', workspaceId: 'mapped-ws' });
      expect(brigade.clientCredentialsToken).not.toHaveBeenCalled();
    });
  });

});
