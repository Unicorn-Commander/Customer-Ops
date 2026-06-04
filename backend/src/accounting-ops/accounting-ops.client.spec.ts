import { ConfigService } from '@nestjs/config';
import { AccountingOpsClient } from './accounting-ops.client';
import { FederationContext } from './accounting-ops.port';
import { InvoiceDraft } from './accounting-ops.types';

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
  return { ok, status, json: async () => body } as unknown as Response;
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
    const client = new AccountingOpsClient(makeConfig({}));

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
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      const pass = client.checkEntitlement(ENTITLED);
      expect(pass).toMatchObject({ allowed: true, mode: 'enforce' });
    });

    it('DENY when accounting-ops is missing (enforce)', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      const deny = client.checkEntitlement(HALF_ENTITLED);
      expect(deny.allowed).toBe(false);
      expect(deny.mode).toBe('enforce');
    });

    it('DENY when no entitlements at all (enforce)', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      expect(client.checkEntitlement(NOT_ENTITLED).allowed).toBe(false);
    });

    it('a denied createInvoice makes NO fetch (defense-in-depth)', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.createInvoice(HALF_ENTITLED, DRAFT)).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('OPEN bootstrap (UC_ENTITLEMENT_MODE=open) bypasses the dual-SKU check', () => {
      const client = new AccountingOpsClient(
        makeConfig({ ...CONFIGURED_ENFORCE, UC_ENTITLEMENT_MODE: 'open' }),
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
      );
      expect(client.checkEntitlement(NOT_ENTITLED)).toMatchObject({ allowed: true, mode: 'open' });
    });

    it('accepts SKU aliases (e.g. accounting_ops / AO) on read', () => {
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
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
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));

      const invoice = await client.createInvoice(ENTITLED, DRAFT);

      // URL + method + JSON-RPC envelope.
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://acct.example.test/mcp');
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
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));

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
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.createInvoice(ENTITLED, DRAFT)).resolves.toBeNull();
    });

    it('returns null on a JSON-RPC error envelope (e.g. AO EntitlementError)', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'denied' } }),
        ) as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
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
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.createInvoice(ENTITLED, DRAFT)).resolves.toBeNull();
    });
  });

  describe('get_invoice poll', () => {
    it('getInvoiceByRef polls by (external_source, external_ref) and maps status/balance', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView({ status: 'partial', balance_due: '1000.0000' }))));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));

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
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));

      const inv = await client.getInvoiceById(ENTITLED, 'inv-1');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.params.arguments).toEqual({ workspace_id: 'ws-aaaa', invoice_id: 'inv-1' });
      expect(inv).toMatchObject({ status: 'paid', balanceDue: '0.0000' });
    });

    it('poll does NOT require the dual SKU (reads are viewer-level on AO)', async () => {
      // A workspace with no entitlement claim can still poll existing invoices.
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse(rpcOk(aoInvoiceView())));
      global.fetch = fetchSpy as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      const inv = await client.getInvoiceByRef(NOT_ENTITLED, 'customer-ops', 'cust:cust-1:idem-key-123');
      expect(inv?.id).toBe('inv-1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null (never throws) on HTTP 500', async () => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, false, 500)) as any;
      const client = new AccountingOpsClient(makeConfig(CONFIGURED_ENFORCE));
      await expect(client.getInvoiceById(ENTITLED, 'inv-1')).resolves.toBeNull();
    });
  });
});
